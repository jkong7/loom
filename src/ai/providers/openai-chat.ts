import type { Context, Message, Model, StreamEvent, StreamOptions, UserContent } from '../types.ts';
import { MessageBuilder, postStream, sseEvents } from '../stream.ts';
import { prepareMessages } from '../transform.ts';

type Wire = Record<string, unknown>;

function userContent(content: UserContent[]): string | Wire[] {
  if (content.every((c) => c.type === 'text')) return content.map((c) => (c as { text: string }).text).join('\n');
  return content.map((c) =>
    c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } },
  );
}

export function toChatMessages(context: Context, model: Model): Wire[] {
  const out: Wire[] = [];
  const sys = context.system.map((b) => b.text).filter(Boolean).join('\n\n');
  if (sys) out.push({ role: model.compat?.supportsDeveloperRole && model.reasoning ? 'developer' : 'system', content: sys });
  const pendingImages: Wire[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...pendingImages.splice(0)] });
  };
  for (const m of prepareMessages(context.messages, model) as Message[]) {
    if (m.role === 'user') {
      flushImages();
      out.push({ role: 'user', content: userContent(m.content) });
    } else if (m.role === 'tool') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n') || (m.isError ? 'error' : 'ok');
      const msg: Wire = { role: 'tool', tool_call_id: m.toolCallId, content: text };
      if (model.compat?.requiresToolResultName) msg.name = m.toolName;
      out.push(msg);
      for (const c of m.content) if (c.type === 'image') pendingImages.push({ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } });
    } else {
      flushImages();
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
      const calls = m.content.filter((c) => c.type === 'toolCall');
      const msg: Wire = { role: 'assistant', content: text || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      }
      const thinking = m.content.find((c) => c.type === 'thinking');
      if (thinking && thinking.type === 'thinking' && thinking.signature === 'reasoning_content') msg.reasoning_content = thinking.text;
      out.push(msg);
    }
  }
  flushImages();
  return out;
}

export function buildChatRequest(model: Model, context: Context, options: StreamOptions): Wire {
  const body: Wire = { model: model.id, messages: toChatMessages(context, model), stream: true };
  if (model.compat?.supportsStreamUsage !== false) body.stream_options = { include_usage: true };
  const maxField = model.compat?.maxTokensField ?? 'max_tokens';
  if (options.maxTokens) body[maxField] = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (context.tools?.length && model.tools) {
    body.tools = context.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (model.reasoning && options.reasoning && model.compat?.supportsReasoningEffort) {
    body.reasoning_effort = options.reasoning === 'off' ? 'minimal' : options.reasoning === 'xhigh' || options.reasoning === 'max' ? 'high' : options.reasoning;
  }
  if (options.sessionId && model.provider === 'openai') body.prompt_cache_key = options.sessionId;
  return body;
}

class ThinkTagSplitter {
  private buf = '';
  private inThink = false;
  feed(delta: string, onText: (s: string) => void, onThink: (s: string) => void): void {
    this.buf += delta;
    while (this.buf) {
      const tag = this.inThink ? '</think>' : '<think>';
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        const chunk = this.buf.slice(0, i);
        if (chunk) (this.inThink ? onThink : onText)(chunk);
        this.buf = this.buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) (this.inThink ? onThink : onText)(emit);
      this.buf = this.buf.slice(this.buf.length - keep);
      break;
    }
  }
  flush(onText: (s: string) => void, onThink: (s: string) => void): void {
    if (this.buf) (this.inThink ? onThink : onText)(this.buf);
    this.buf = '';
  }
}

const STOP: Record<string, 'stop' | 'length' | 'toolUse' | 'refusal'> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'toolUse',
  function_call: 'toolUse',
  content_filter: 'refusal',
};

export async function* streamOpenAIChat(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const b = new MessageBuilder(model);
  yield b.start();
  try {
    const body = buildChatRequest(model, context, options);
    options.onPayload?.(body);
    const headers: Record<string, string> = { ...model.headers, ...options.headers };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const base = (options.baseUrl || model.baseUrl).replace(/\/$/, '');
    const res = await postStream(`${base}/chat/completions`, body, headers, options);
    let stop: string | undefined;
    const splitter = model.compat?.thinkTags !== false ? new ThinkTagSplitter() : null;
    const onText = (s: string) => {
      b.end('think');
      b.text('text', s);
    };
    const onThink = (s: string) => b.thinking('think', s, { signature: 'think_tag' });
    const toolKeys = new Map<number, string>();
    for await (const ev of sseEvents(res.body!, options.signal)) {
      if (!ev.data || ev.data === '[DONE]') continue;
      const d = JSON.parse(ev.data);
      if (d.error) throw new Error(typeof d.error === 'string' ? d.error : d.error.message || JSON.stringify(d.error));
      if (d.id && !b.message.responseId) b.message.responseId = d.id;
      const u = d.usage;
      if (u) {
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        b.usage({ input: (u.prompt_tokens ?? 0) - cached, output: u.completion_tokens ?? 0, cacheRead: cached, reasoning: u.completion_tokens_details?.reasoning_tokens });
      }
      const choice = d.choices?.[0];
      if (!choice) {
        yield* b.drain();
        continue;
      }
      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content ?? delta.reasoning ?? (typeof delta.reasoning_details === 'string' ? delta.reasoning_details : undefined);
      if (typeof reasoning === 'string' && reasoning) b.thinking('reason', reasoning, { signature: delta.reasoning_content !== undefined ? 'reasoning_content' : 'reasoning' });
      if (typeof delta.content === 'string' && delta.content) {
        b.end('reason');
        if (splitter) splitter.feed(delta.content, onText, onThink);
        else b.text('text', delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        b.end('reason');
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : toolKeys.size;
          let key = toolKeys.get(idx);
          if (!key) {
            key = `tool${idx}`;
            toolKeys.set(idx, key);
            b.end('text');
            b.toolStart(key, tc.id || `call_${idx}_${Date.now().toString(36)}`, tc.function?.name || '');
          } else b.toolUpdate(key, { id: tc.id, name: tc.function?.name });
          const args = tc.function?.arguments;
          if (typeof args === 'string') b.toolArgs(key, args);
          else if (args && typeof args === 'object') b.toolSetArgs(key, args);
        }
      }
      if (choice.finish_reason) stop = choice.finish_reason;
      yield* b.drain();
    }
    splitter?.flush(onText, onThink);
    yield* b.drain();
    yield b.finish(STOP[stop || 'stop'] ?? 'stop', model);
  } catch (err) {
    yield* b.drain();
    yield b.fail(err, options.signal?.aborted);
  }
}
