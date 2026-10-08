import type { Context, Model, StreamEvent, StreamOptions, UserContent } from '../types.ts';
import { MessageBuilder, postStream, sseEvents } from '../stream.ts';
import { prepareMessages } from '../transform.ts';

type Wire = Record<string, unknown>;

function inputContent(content: UserContent[]): Wire[] {
  return content.map((c) =>
    c.type === 'text' ? { type: 'input_text', text: c.text } : { type: 'input_image', image_url: `data:${c.mimeType};base64,${c.data}`, detail: 'auto' },
  );
}

export function toResponsesInput(context: Context, model: Model): Wire[] {
  const out: Wire[] = [];
  for (const m of prepareMessages(context.messages, model)) {
    if (m.role === 'user') out.push({ role: 'user', content: inputContent(m.content) });
    else if (m.role === 'tool') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: text || (m.isError ? 'error' : 'ok') });
      const images = m.content.filter((c) => c.type === 'image');
      if (images.length) out.push({ role: 'user', content: [{ type: 'input_text', text: `Images returned by ${m.toolName}:` }, ...inputContent(images)] });
    } else {
      for (const c of m.content) {
        if (c.type === 'thinking') {
          if (!c.signature) continue;
          try {
            out.push(JSON.parse(c.signature));
          } catch {}
        } else if (c.type === 'text') {
          out.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: c.text, annotations: [] }] });
        } else {
          out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
        }
      }
    }
  }
  return out;
}

export function buildResponsesRequest(model: Model, context: Context, options: StreamOptions): Wire {
  const body: Wire = {
    model: model.id,
    input: toResponsesInput(context, model),
    stream: true,
    store: false,
  };
  const sys = context.system.map((b) => b.text).filter(Boolean).join('\n\n');
  if (sys) body.instructions = sys;
  if (options.maxTokens) body.max_output_tokens = options.maxTokens;
  if (options.temperature !== undefined && !model.reasoning) body.temperature = options.temperature;
  if (context.tools?.length) {
    body.tools = context.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  }
  if (model.reasoning) {
    const lvl = options.reasoning;
    const effort = !lvl ? 'medium' : lvl === 'off' ? 'minimal' : lvl === 'max' ? 'xhigh' : lvl;
    body.reasoning = { effort, summary: 'auto' };
    body.include = ['reasoning.encrypted_content'];
  }
  if (options.sessionId) body.prompt_cache_key = options.sessionId;
  return body;
}

export async function* streamOpenAIResponses(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const b = new MessageBuilder(model);
  yield b.start();
  try {
    const body = buildResponsesRequest(model, context, options);
    options.onPayload?.(body);
    const headers: Record<string, string> = { ...model.headers, ...options.headers };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const base = (options.baseUrl || model.baseUrl).replace(/\/$/, '');
    const res = await postStream(`${base}/responses`, body, headers, options);
    let stop: 'stop' | 'length' | 'toolUse' | 'refusal' = 'stop';
    for await (const ev of sseEvents(res.body!, options.signal)) {
      if (!ev.data || ev.data === '[DONE]') continue;
      const d = JSON.parse(ev.data);
      const type: string = d.type || ev.event || '';
      const key = (id: unknown) => `item:${String(id ?? d.output_index)}`;
      switch (type) {
        case 'response.created':
          b.message.responseId = d.response?.id;
          break;
        case 'response.output_item.added': {
          const item = d.item || {};
          if (item.type === 'function_call') b.toolStart(key(item.id), item.call_id || item.id, item.name || '');
          else if (item.type === 'reasoning') b.thinking(key(item.id), '');
          else if (item.type === 'message') b.text(key(item.id), '');
          break;
        }
        case 'response.output_text.delta':
          b.text(key(d.item_id), d.delta || '');
          break;
        case 'response.refusal.delta':
          b.text(key(d.item_id), d.delta || '');
          stop = 'refusal';
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          b.thinking(key(d.item_id), d.delta || '');
          break;
        case 'response.reasoning_summary_part.done':
          b.thinking(key(d.item_id), '\n\n');
          break;
        case 'response.function_call_arguments.delta':
          b.toolArgs(key(d.item_id), d.delta || '');
          break;
        case 'response.function_call_arguments.done':
          if (typeof d.arguments === 'string') b.toolSetRaw(key(d.item_id), d.arguments);
          break;
        case 'response.output_item.done': {
          const item = d.item || {};
          const k = key(item.id);
          if (item.type === 'reasoning') {
            if (!b.has(k)) b.thinking(k, '');
            b.signature(k, JSON.stringify({ type: 'reasoning', id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content }), false);
          }
          if (item.type === 'function_call' && typeof item.arguments === 'string') b.toolSetRaw(k, item.arguments);
          b.end(k);
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const r = d.response || {};
          const u = r.usage || {};
          const cached = u.input_tokens_details?.cached_tokens ?? 0;
          b.usage({ input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, reasoning: u.output_tokens_details?.reasoning_tokens });
          if (type === 'response.incomplete' || r.status === 'incomplete') stop = 'length';
          break;
        }
        case 'response.failed':
          throw new Error(d.response?.error?.message || 'response failed');
        case 'error':
          throw new Error(d.message || d.error?.message || 'openai stream error');
      }
      yield* b.drain();
    }
    yield* b.drain();
    yield b.finish(stop, model);
  } catch (err) {
    yield* b.drain();
    yield b.fail(err, options.signal?.aborted);
  }
}
