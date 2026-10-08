import type { Context, Model, StopReason, StreamEvent, StreamOptions, Usage } from '../types.ts';
import { textOf } from '../types.ts';
import { MessageBuilder } from '../stream.ts';
import { estimateContextTokens } from '../tokens.ts';

export interface MockTurn {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
  stop?: StopReason;
  error?: string;
  usage?: Partial<Usage>;
  delayMs?: number;
}

export type MockStep = MockTurn | ((context: Context, call: number) => MockTurn);

export class MockScript {
  readonly steps: MockStep[];
  readonly calls: Context[] = [];
  fallback: MockStep;
  constructor(steps: MockStep[] = [], fallback: MockStep = echoTurn) {
    this.steps = [...steps];
    this.fallback = fallback;
  }
  push(...steps: MockStep[]): this {
    this.steps.push(...steps);
    return this;
  }
  next(context: Context): MockTurn {
    const n = this.calls.length;
    this.calls.push(structuredClone(context));
    const step = this.steps.shift() ?? this.fallback;
    return typeof step === 'function' ? step(context, n) : step;
  }
}

export function echoTurn(context: Context): MockTurn {
  const last = [...context.messages].reverse().find((m) => m.role === 'user' || m.role === 'tool');
  if (!last) return { text: 'mock: (no input)' };
  if (last.role === 'tool') return { text: `mock: ${last.toolName} returned ${textOf(last.content).slice(0, 400)}` };
  const text = textOf(last.content);
  const m = text.match(/^call\s+([\w.-]+)\s*(\{[\s\S]*\})?\s*$/);
  if (m) {
    let args: Record<string, unknown> = {};
    try {
      args = m[2] ? JSON.parse(m[2]) : {};
    } catch {}
    return { text: `Calling ${m[1]}.`, toolCalls: [{ name: m[1], args }] };
  }
  return { text: `mock: ${text}` };
}

const scripts = new Map<string, MockScript>();

export function setMockScript(modelId: string, script: MockScript): MockScript {
  scripts.set(modelId, script);
  return script;
}

export function getMockScript(modelId: string): MockScript {
  let s = scripts.get(modelId);
  if (!s) {
    s = new MockScript();
    scripts.set(modelId, s);
  }
  return s;
}

function chunks(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new Error('aborted'));
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))), { once: true });
  });
}

let callSeq = 0;

export async function* streamMock(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const b = new MessageBuilder(model);
  yield b.start();
  try {
    options.onPayload?.({ model: model.id, context });
    const turn = getMockScript(model.id).next(context);
    if (turn.delayMs) await sleep(turn.delayMs, options.signal);
    if (turn.error) throw new Error(turn.error);
    if (turn.thinking) {
      for (const c of chunks(turn.thinking)) {
        b.thinking('think', c, { signature: `mock-sig-${model.id}` });
        yield* b.drain();
      }
      b.end('think');
    }
    if (turn.text) {
      for (const c of chunks(turn.text)) {
        if (options.signal?.aborted) throw new Error('aborted');
        b.text('text', c);
        yield* b.drain();
      }
      b.end('text');
    }
    for (const [i, call] of (turn.toolCalls ?? []).entries()) {
      const k = `tool${i}`;
      b.toolStart(k, call.id ?? `mock_call_${++callSeq}`, call.name);
      for (const c of chunks(JSON.stringify(call.args), 16)) b.toolArgs(k, c);
      b.end(k);
      yield* b.drain();
    }
    const input = estimateContextTokens(context);
    b.usage({ input, output: Math.ceil(((turn.text?.length ?? 0) + (turn.thinking?.length ?? 0) + JSON.stringify(turn.toolCalls ?? []).length) / 4), ...turn.usage });
    yield* b.drain();
    yield b.finish(turn.stop ?? 'stop', model);
  } catch (err) {
    yield* b.drain();
    yield b.fail(err, options.signal?.aborted);
  }
}
