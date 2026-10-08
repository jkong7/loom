import type { AssistantContent, AssistantMessage, Message, Model, ToolResultMessage, UserContent } from './types.ts';

export function sanitizeToolId(id: string, max = 64): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (clean.length <= max) return clean || 'call';
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const suffix = (h >>> 0).toString(36);
  return clean.slice(0, max - suffix.length - 1) + '_' + suffix;
}

function sameModel(a: AssistantMessage, model: Model): boolean {
  return a.provider === model.provider && a.model === model.id && a.api === model.api;
}

function stripImages(content: UserContent[], model: Model): UserContent[] {
  if (model.input.includes('image')) return content;
  return content.map((c) => (c.type === 'image' ? { type: 'text', text: `[image omitted: ${model.id} does not accept images]` } : c));
}

export function prepareMessages(messages: Message[], model: Model, opts: { toolIdMax?: number } = {}): Message[] {
  const idMax = opts.toolIdMax ?? model.compat?.toolIdMaxLength ?? 64;
  const out: Message[] = [];
  let pending: Map<string, string> | null = null;

  const flushPending = () => {
    if (!pending) return;
    for (const [id, name] of pending) {
      out.push({ role: 'tool', toolCallId: id, toolName: name, content: [{ type: 'text', text: 'No result: the tool call was interrupted before it finished.' }], isError: true, ts: Date.now() });
    }
    pending = null;
  };

  for (const m of messages) {
    if (m.role === 'user') {
      flushPending();
      out.push({ ...m, content: stripImages(m.content, model) });
      continue;
    }
    if (m.role === 'tool') {
      const id = sanitizeToolId(m.toolCallId, idMax);
      if (!pending || !pending.has(id)) continue;
      pending.delete(id);
      const r: ToolResultMessage = { ...m, toolCallId: id, content: stripImages(m.content, model) };
      out.push(r);
      if (pending.size === 0) pending = null;
      continue;
    }
    flushPending();
    const broken = m.stopReason === 'error' || m.stopReason === 'aborted';
    const keepThinking = sameModel(m, model);
    const content: AssistantContent[] = [];
    for (const c of m.content) {
      if (c.type === 'thinking') {
        if (broken || !keepThinking) continue;
        if (c.redacted || c.signature || c.text) content.push(c);
        continue;
      }
      if (c.type === 'toolCall') {
        if (broken) continue;
        content.push({ ...c, id: sanitizeToolId(c.id, idMax), signature: keepThinking ? c.signature : undefined });
        continue;
      }
      if (c.text) content.push(c);
    }
    if (!content.length) continue;
    out.push({ ...m, content });
    const calls = content.filter((c) => c.type === 'toolCall');
    if (calls.length) pending = new Map(calls.map((c) => [c.id, c.name]));
  }
  flushPending();
  return out;
}

export function stripThinking(messages: Message[]): Message[] {
  return messages.map((m) => (m.role === 'assistant' ? { ...m, content: m.content.filter((c) => c.type !== 'thinking') } : m));
}
