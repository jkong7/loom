import type { Api, AssistantMessage, Model, StopReason, StreamEvent, ThinkingPart, ToolCallPart, Usage, TextPart } from './types.ts';
import { emptyUsage } from './types.ts';

export class EventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  private resolveResult!: (r: R) => void;
  readonly result: Promise<R>;

  constructor() {
    this.result = new Promise<R>((res) => (this.resolveResult = res));
  }

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.queue.push(item);
  }

  end(result: R): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveResult(result);
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.queue.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

export function parseToolArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  const text = raw.trim();
  if (!text) return { args: {} };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v as Record<string, unknown> };
    return { args: {}, error: 'tool arguments must be a JSON object' };
  } catch (err) {
    const repaired = repairJson(text);
    if (repaired) return { args: repaired };
    return { args: {}, error: `invalid JSON in tool arguments: ${(err as Error).message}` };
  }
}

function repairJson(text: string): Record<string, unknown> | null {
  let s = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  let depth = 0;
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      depth++;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      depth--;
    }
  }
  if (inStr) s += '"';
  s += stack.reverse().join('');
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

type Slot =
  | { kind: 'text'; index: number }
  | { kind: 'thinking'; index: number }
  | { kind: 'tool'; index: number; raw: string };

export class MessageBuilder {
  readonly message: AssistantMessage;
  private slots = new Map<string, Slot>();
  private events: StreamEvent[] = [];

  constructor(model: Model, api: Api = model.api) {
    this.message = {
      role: 'assistant',
      content: [],
      provider: model.provider,
      model: model.id,
      api,
      usage: emptyUsage(),
      stopReason: 'stop',
      ts: Date.now(),
    };
  }

  start(): StreamEvent {
    return { type: 'start', partial: this.message };
  }

  drain(): StreamEvent[] {
    return this.events.splice(0);
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  text(key: string, delta: string): void {
    let slot = this.slots.get(key);
    if (!slot) {
      const index = this.message.content.push({ type: 'text', text: '' }) - 1;
      slot = { kind: 'text', index };
      this.slots.set(key, slot);
      this.events.push({ type: 'text_start', index });
    }
    if (!delta) return;
    (this.message.content[slot.index] as TextPart).text += delta;
    this.events.push({ type: 'text_delta', index: slot.index, delta });
  }

  thinking(key: string, delta: string, extra: Partial<ThinkingPart> = {}): void {
    let slot = this.slots.get(key);
    if (!slot) {
      const index =
        this.message.content.push({ type: 'thinking', text: '', provider: this.message.provider, model: this.message.model }) - 1;
      slot = { kind: 'thinking', index };
      this.slots.set(key, slot);
      this.events.push({ type: 'thinking_start', index });
    }
    const part = this.message.content[slot.index] as ThinkingPart;
    Object.assign(part, extra);
    if (!delta) return;
    part.text += delta;
    this.events.push({ type: 'thinking_delta', index: slot.index, delta });
  }

  signature(key: string, sig: string, append = true): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    const part = this.message.content[slot.index] as ThinkingPart | ToolCallPart;
    part.signature = append ? (part.signature || '') + sig : sig;
  }

  toolStart(key: string, id: string, name: string): void {
    if (this.slots.has(key)) return;
    const index = this.message.content.push({ type: 'toolCall', id, name, args: {} }) - 1;
    this.slots.set(key, { kind: 'tool', index, raw: '' });
    this.events.push({ type: 'toolcall_start', index, id, name });
  }

  toolUpdate(key: string, patch: { id?: string; name?: string }): void {
    const slot = this.slots.get(key);
    if (!slot || slot.kind !== 'tool') return;
    const part = this.message.content[slot.index] as ToolCallPart;
    if (patch.id) part.id = patch.id;
    if (patch.name && patch.name !== part.name) part.name += patch.name;
  }

  toolArgs(key: string, delta: string): void {
    const slot = this.slots.get(key);
    if (!slot || slot.kind !== 'tool' || !delta) return;
    slot.raw += delta;
    this.events.push({ type: 'toolcall_delta', index: slot.index, delta });
  }

  toolSetArgs(key: string, args: Record<string, unknown>): void {
    const slot = this.slots.get(key);
    if (!slot || slot.kind !== 'tool') return;
    slot.raw = JSON.stringify(args);
  }

  toolSetRaw(key: string, raw: string): void {
    const slot = this.slots.get(key);
    if (slot && slot.kind === 'tool') slot.raw = raw;
  }

  end(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    const part = this.message.content[slot.index];
    if (slot.kind === 'text') this.events.push({ type: 'text_end', index: slot.index, text: (part as TextPart).text });
    else if (slot.kind === 'thinking') this.events.push({ type: 'thinking_end', index: slot.index, text: (part as ThinkingPart).text });
    else {
      const call = part as ToolCallPart;
      const parsed = parseToolArgs(slot.raw);
      call.args = parsed.error ? { __invalid_json: slot.raw, __error: parsed.error } : parsed.args;
      this.events.push({ type: 'toolcall_end', index: slot.index, call });
    }
  }

  endAll(): void {
    for (const key of [...this.slots.keys()]) this.end(key);
  }

  usage(patch: Partial<Usage>): void {
    for (const [k, v] of Object.entries(patch)) if (typeof v === 'number' && !Number.isNaN(v)) (this.message.usage as unknown as Record<string, number>)[k] = v;
  }

  finish(stop: StopReason, model?: Model): StreamEvent {
    this.endAll();
    this.message.content = this.message.content.filter((c) => !(c.type === 'text' && !c.text && this.message.content.length > 1));
    if (stop === 'stop' && this.message.content.some((c) => c.type === 'toolCall')) stop = 'toolUse';
    this.message.stopReason = stop;
    if (model?.cost) this.message.usage.cost = computeCost(model, this.message.usage);
    return { type: 'done', message: this.message };
  }

  fail(error: unknown, aborted = false): StreamEvent {
    this.endAll();
    this.message.stopReason = aborted ? 'aborted' : 'error';
    this.message.error = aborted ? 'aborted' : error instanceof Error ? error.message : String(error);
    return { type: 'error', message: this.message };
  }
}

export function computeCost(model: Model, u: Usage): number {
  const c = model.cost;
  if (!c) return 0;
  return (u.input * c.input + u.output * c.output + u.cacheRead * (c.cacheRead ?? c.input) + u.cacheWrite * (c.cacheWrite ?? c.input)) / 1e6;
}

export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith(':')) continue;
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (signal?.aborted) throw new Error('aborted');
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

export class HttpError extends Error {
  status: number;
  body: string;
  retryAfterMs?: number;
  constructor(status: number, body: string, retryAfterMs?: number) {
    super(`HTTP ${status}: ${summarizeErrorBody(body)}`);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

function summarizeErrorBody(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    const msg = typeof e === 'string' ? e : e?.message || j.message;
    if (msg) return String(msg).slice(0, 500);
  } catch {}
  return body.slice(0, 500);
}

export function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export async function postStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal; fetch?: typeof fetch; maxRetries?: number; timeoutMs?: number },
): Promise<Response> {
  const f = opts.fetch || fetch;
  const max = opts.maxRetries ?? 2;
  let attempt = 0;
  while (true) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error('connect timeout')), opts.timeoutMs ?? 120000);
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (res.ok && res.body) return res;
      const text = await res.text().catch(() => '');
      const ra = Number(res.headers.get('retry-after'));
      const err = new HttpError(res.status, text, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
      if (attempt < max && isRetryable(res.status) && !opts.signal?.aborted) {
        await delay(err.retryAfterMs ?? 500 * 2 ** attempt, opts.signal);
        attempt++;
        continue;
      }
      throw err;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError || opts.signal?.aborted) throw err;
      if (attempt < max) {
        await delay(500 * 2 ** attempt, opts.signal);
        attempt++;
        continue;
      }
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const t = setTimeout(res, Math.min(ms, 30000));
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });
}
