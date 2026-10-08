import type { Context, Model, StreamEvent, StreamOptions, UserContent } from '../types.ts';
import { MessageBuilder, postStream, sseEvents } from '../stream.ts';
import { prepareMessages } from '../transform.ts';

type Wire = Record<string, unknown>;

function parts(content: UserContent[]): Wire[] {
  return content.map((c) => (c.type === 'text' ? { text: c.text } : { inlineData: { mimeType: c.mimeType, data: c.data } }));
}

export function toGeminiContents(context: Context, model: Model): Wire[] {
  const out: { role: string; parts: Wire[] }[] = [];
  const push = (role: string, p: Wire[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...p);
    else out.push({ role, parts: p });
  };
  for (const m of prepareMessages(context.messages, model)) {
    if (m.role === 'user') push('user', parts(m.content));
    else if (m.role === 'tool') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
      const p: Wire[] = [{ functionResponse: { name: m.toolName, id: m.toolCallId, response: m.isError ? { error: text } : { output: text } } }];
      const images = m.content.filter((c) => c.type === 'image');
      if (images.length) p.push(...parts(images));
      push('user', p);
    } else {
      const p: Wire[] = [];
      for (const c of m.content) {
        if (c.type === 'text') p.push({ text: c.text });
        else if (c.type === 'thinking') {
          if (c.signature) p.push({ text: c.text, thought: true, thoughtSignature: c.signature });
        } else {
          const fc: Wire = { functionCall: { name: c.name, args: c.args, id: c.id } };
          if (c.signature) fc.thoughtSignature = c.signature;
          p.push(fc);
        }
      }
      if (p.length) push('model', p);
    }
  }
  return out;
}

const BUDGET: Record<string, number> = { off: 0, minimal: 512, low: 2048, medium: 8192, high: 24576, xhigh: 32768, max: 32768 };

export function buildGeminiRequest(model: Model, context: Context, options: StreamOptions): Wire {
  const body: Wire = { contents: toGeminiContents(context, model) };
  const sys = context.system.map((b) => b.text).filter(Boolean).join('\n\n');
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (context.tools?.length) {
    body.tools = [{ functionDeclarations: context.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
  }
  const gen: Wire = {};
  if (options.maxTokens) gen.maxOutputTokens = options.maxTokens;
  if (options.temperature !== undefined) gen.temperature = options.temperature;
  if (model.reasoning) {
    const lvl = options.reasoning;
    gen.thinkingConfig = lvl ? { includeThoughts: lvl !== 'off', thinkingBudget: BUDGET[lvl] } : { includeThoughts: true };
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

const STOP: Record<string, 'stop' | 'length' | 'refusal'> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  BLOCKLIST: 'refusal',
  SPII: 'refusal',
};

export async function* streamGoogle(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const b = new MessageBuilder(model);
  yield b.start();
  try {
    const body = buildGeminiRequest(model, context, options);
    options.onPayload?.(body);
    const headers: Record<string, string> = { ...model.headers, ...options.headers };
    if (options.apiKey) headers['x-goog-api-key'] = options.apiKey;
    const base = (options.baseUrl || model.baseUrl).replace(/\/$/, '');
    const res = await postStream(`${base}/models/${model.id}:streamGenerateContent?alt=sse`, body, headers, options);
    let stop = 'STOP';
    let calls = 0;
    let lastKind: 'text' | 'think' | null = null;
    let seg = 0;
    for await (const ev of sseEvents(res.body!, options.signal)) {
      if (!ev.data) continue;
      const d = JSON.parse(ev.data);
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      if (d.responseId) b.message.responseId = d.responseId;
      const u = d.usageMetadata;
      if (u) {
        const cached = u.cachedContentTokenCount ?? 0;
        b.usage({ input: (u.promptTokenCount ?? 0) - cached, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: cached, reasoning: u.thoughtsTokenCount });
      }
      const cand = d.candidates?.[0];
      if (d.promptFeedback?.blockReason && !cand) stop = 'SAFETY';
      for (const p of cand?.content?.parts ?? []) {
        if (p.functionCall) {
          if (lastKind) b.end(`${lastKind}${seg}`);
          lastKind = null;
          const k = `call${calls}`;
          b.toolStart(k, p.functionCall.id || `call_${calls}_${Date.now().toString(36)}`, p.functionCall.name);
          b.toolSetArgs(k, p.functionCall.args || {});
          if (p.thoughtSignature) b.signature(k, p.thoughtSignature, false);
          b.end(k);
          calls++;
          continue;
        }
        if (typeof p.text !== 'string') continue;
        const kind = p.thought ? 'think' : 'text';
        if (kind !== lastKind) {
          if (lastKind) b.end(`${lastKind}${seg}`);
          seg++;
          lastKind = kind;
        }
        if (kind === 'think') b.thinking(`think${seg}`, p.text);
        else b.text(`text${seg}`, p.text);
        if (p.thoughtSignature) {
          if (kind === 'think') b.signature(`think${seg}`, p.thoughtSignature, false);
          else {
            b.end(`text${seg}`);
            b.thinking(`sig${seg}`, '', { signature: p.thoughtSignature });
            b.end(`sig${seg}`);
            lastKind = null;
          }
        }
      }
      if (cand?.finishReason) stop = cand.finishReason;
      yield* b.drain();
    }
    yield* b.drain();
    if (stop === 'MALFORMED_FUNCTION_CALL') yield b.fail(new Error('the model produced a malformed function call'));
    else yield b.finish(STOP[stop] ?? 'stop', model);
  } catch (err) {
    yield* b.drain();
    yield b.fail(err, options.signal?.aborted);
  }
}
