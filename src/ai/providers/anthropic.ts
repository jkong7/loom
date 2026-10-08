import type { Context, Message, Model, StreamEvent, StreamOptions, ToolSpec, UserContent } from '../types.ts';
import { MessageBuilder, postStream, sseEvents } from '../stream.ts';
import { prepareMessages } from '../transform.ts';

type Block = Record<string, unknown>;
type WireMessage = { role: 'user' | 'assistant'; content: Block[] };

function userBlocks(content: UserContent[]): Block[] {
  return content.map((c) =>
    c.type === 'text' ? { type: 'text', text: c.text || ' ' } : { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } },
  );
}

export function toAnthropicMessages(messages: Message[], model: Model): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of prepareMessages(messages, model)) {
    if (m.role === 'user') push('user', userBlocks(m.content));
    else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: userBlocks(m.content), is_error: m.isError || undefined }]);
    } else {
      const blocks: Block[] = [];
      for (const c of m.content) {
        if (c.type === 'text') blocks.push({ type: 'text', text: c.text });
        else if (c.type === 'thinking') {
          if (c.redacted) blocks.push({ type: 'redacted_thinking', data: c.signature });
          else if (c.signature) blocks.push({ type: 'thinking', thinking: c.text, signature: c.signature });
        } else blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      if (blocks.length) push('assistant', blocks);
    }
  }
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    const ordered = [...last.content.filter((b) => b.type === 'tool_result'), ...last.content.filter((b) => b.type !== 'tool_result')];
    last.content = ordered;
  }
  return out;
}

function markCache(messages: WireMessage[]): void {
  const users = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  for (const i of users.slice(-2)) {
    const blocks = messages[i].content;
    const target = blocks[blocks.length - 1];
    if (target) target.cache_control = { type: 'ephemeral' };
  }
}

export function anthropicTools(tools: ToolSpec[] | undefined, cache: boolean): Block[] | undefined {
  if (!tools?.length) return undefined;
  const out: Block[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (cache) out[out.length - 1].cache_control = { type: 'ephemeral' };
  return out;
}

const EFFORT: Record<string, string> = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const BUDGET: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32000 };

export function buildAnthropicRequest(model: Model, context: Context, options: StreamOptions): Record<string, unknown> {
  const cache = options.cache !== false && model.caching;
  const system = context.system.filter((b) => b.text).map((b) => ({ type: 'text', text: b.text, ...(cache && b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }));
  const messages = toAnthropicMessages(context.messages, model);
  if (cache) markCache(messages);
  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: options.maxTokens ?? Math.min(model.maxOutput, 32000),
    stream: true,
    messages,
  };
  if (system.length) body.system = system;
  const tools = anthropicTools(context.tools, cache);
  if (tools) body.tools = tools;
  const level = options.reasoning;
  if (model.reasoning && model.thinking === 'adaptive') {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    if (level) body.output_config = { effort: level === 'off' ? 'low' : EFFORT[level] };
  } else if (model.reasoning && model.thinking === 'budget' && level && level !== 'off') {
    const budget = BUDGET[level];
    body.thinking = { type: 'enabled', budget_tokens: budget };
    if ((body.max_tokens as number) <= budget) body.max_tokens = budget + 4096;
  } else if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}

const STOP: Record<string, 'stop' | 'length' | 'toolUse' | 'refusal'> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'toolUse',
  refusal: 'refusal',
  model_context_window_exceeded: 'length',
};

export async function* streamAnthropic(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const b = new MessageBuilder(model);
  yield b.start();
  try {
    const body = buildAnthropicRequest(model, context, options);
    options.onPayload?.(body);
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01', ...model.headers, ...options.headers };
    if (options.apiKey) {
      if (options.apiKey.startsWith('sk-ant-oat')) {
        headers.authorization = `Bearer ${options.apiKey}`;
        headers['anthropic-beta'] = [headers['anthropic-beta'], 'oauth-2025-04-20'].filter(Boolean).join(',');
      } else headers['x-api-key'] = options.apiKey;
    }
    const base = (options.baseUrl || model.baseUrl).replace(/\/$/, '');
    const res = await postStream(`${base}/v1/messages`, body, headers, options);
    let stop: string | undefined;
    for await (const ev of sseEvents(res.body!, options.signal)) {
      if (!ev.data || ev.data === '[DONE]') continue;
      const d = JSON.parse(ev.data);
      switch (d.type) {
        case 'message_start': {
          const u = d.message?.usage || {};
          b.message.responseId = d.message?.id;
          b.usage({ input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 });
          break;
        }
        case 'content_block_start': {
          const key = String(d.index);
          const cb = d.content_block || {};
          if (cb.type === 'text') b.text(key, cb.text || '');
          else if (cb.type === 'thinking') b.thinking(key, cb.thinking || '');
          else if (cb.type === 'redacted_thinking') b.thinking(key, '', { redacted: true, signature: cb.data });
          else if (cb.type === 'tool_use') {
            b.toolStart(key, cb.id, cb.name);
            if (cb.input && Object.keys(cb.input).length) b.toolSetArgs(key, cb.input);
          }
          break;
        }
        case 'content_block_delta': {
          const key = String(d.index);
          const delta = d.delta || {};
          if (delta.type === 'text_delta') b.text(key, delta.text);
          else if (delta.type === 'thinking_delta') b.thinking(key, delta.thinking);
          else if (delta.type === 'signature_delta') b.signature(key, delta.signature);
          else if (delta.type === 'input_json_delta') b.toolArgs(key, delta.partial_json);
          break;
        }
        case 'content_block_stop':
          b.end(String(d.index));
          break;
        case 'message_delta': {
          if (d.delta?.stop_reason) stop = d.delta.stop_reason;
          const u = d.usage || {};
          if (u.output_tokens !== undefined) b.usage({ output: u.output_tokens });
          if (u.input_tokens) b.usage({ input: u.input_tokens });
          if (u.cache_read_input_tokens) b.usage({ cacheRead: u.cache_read_input_tokens });
          if (u.cache_creation_input_tokens) b.usage({ cacheWrite: u.cache_creation_input_tokens });
          break;
        }
        case 'error':
          throw new Error(d.error?.message || 'anthropic stream error');
      }
      yield* b.drain();
    }
    yield* b.drain();
    yield b.finish(STOP[stop || 'end_turn'] ?? 'stop', model);
  } catch (err) {
    yield* b.drain();
    yield b.fail(err, options.signal?.aborted);
  }
}
