import type { AssistantMessage, Context, Message, Model, StreamEvent, TextPart, ToolCallPart } from './types.ts';
import { textOf } from './types.ts';
import { parseToolArgs } from './stream.ts';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function needsShim(model: Model, context: Context): boolean {
  return !!context.tools?.length && (!model.tools || !!model.compat?.toolShim);
}

export function shimInstructions(context: Context): string {
  const specs = (context.tools ?? []).map((t) => `## ${t.name}\n${t.description}\nArguments (JSON Schema): ${JSON.stringify(t.parameters)}`).join('\n\n');
  return `# Tools

You can call tools. To call one, write a tool call block on its own line and then stop writing:

${OPEN}{"name": "tool_name", "arguments": {"arg": "value"}}${CLOSE}

You may write several blocks in one reply. After you stop, the results come back in <tool_result> blocks. Only call tools listed here, with arguments that match their schema. When you need no more tools, answer normally without any tool call block.

${specs}`;
}

let shimSeq = 0;

export function toShimContext(context: Context): Context {
  const messages: Message[] = [];
  for (const m of context.messages) {
    if (m.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      for (const c of m.content) {
        if (c.type === 'toolCall') content.push({ type: 'text', text: `${OPEN}${JSON.stringify({ name: c.name, arguments: c.args })}${CLOSE}` });
        else if (c.type === 'text') content.push(c);
      }
      messages.push({ ...m, content });
    } else if (m.role === 'tool') {
      const text = `<tool_result name="${m.toolName}"${m.isError ? ' error="true"' : ''}>\n${textOf(m.content, { includeMeta: true })}\n</tool_result>`;
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'user' && prev.content.every((c) => c.type === 'text' && c.text.startsWith('<tool_result'))) prev.content.push({ type: 'text', text });
      else messages.push({ role: 'user', content: [{ type: 'text', text }], ts: m.ts });
    } else messages.push(m);
  }
  return { system: [...context.system.slice(0, 1), { text: shimInstructions(context) }, ...context.system.slice(1)], messages };
}

export function extractToolCalls(text: string): { text: string; calls: ToolCallPart[] } {
  const calls: ToolCallPart[] = [];
  let rest = text;
  const re = /<tool_call>\s*([\s\S]*?)\s*(<\/tool_call>|$)/g;
  rest = text.replace(re, (_m, body: string) => {
    const json = body.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    const parsed = parseToolArgs(json);
    const obj = parsed.args as { name?: string; arguments?: unknown; parameters?: unknown };
    if (obj && typeof obj.name === 'string') {
      const args = (obj.arguments ?? obj.parameters ?? {}) as Record<string, unknown>;
      calls.push({ type: 'toolCall', id: `shim_${Date.now().toString(36)}_${++shimSeq}`, name: obj.name, args: typeof args === 'string' ? parseToolArgs(args).args : args });
    }
    return '';
  });
  return { text: rest.trim(), calls };
}

export async function* shimStream(inner: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
  let held = '';
  let blocked = false;
  for await (const ev of inner) {
    if (ev.type === 'text_delta') {
      if (blocked) continue;
      held += ev.delta;
      const at = held.indexOf(OPEN);
      if (at >= 0) {
        blocked = true;
        if (at > 0) yield { ...ev, delta: held.slice(0, at) };
        held = '';
        continue;
      }
      let keep = 0;
      for (let k = Math.min(OPEN.length - 1, held.length); k > 0; k--) {
        if (OPEN.startsWith(held.slice(-k))) {
          keep = k;
          break;
        }
      }
      const emit = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      if (emit) yield { ...ev, delta: emit };
      continue;
    }
    if (ev.type === 'done' || ev.type === 'error') {
      const msg = ev.message;
      const full = msg.content.filter((c): c is TextPart => c.type === 'text').map((c) => c.text).join('');
      const { text, calls } = extractToolCalls(full);
      const others = msg.content.filter((c) => c.type !== 'text');
      msg.content = [...others, ...(text ? [{ type: 'text' as const, text }] : []), ...calls];
      if (ev.type === 'done' && calls.length && msg.stopReason === 'stop') msg.stopReason = 'toolUse';
      for (const call of calls) yield { type: 'toolcall_end', index: msg.content.indexOf(call), call };
      yield ev;
      continue;
    }
    yield ev;
  }
}
