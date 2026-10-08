import type { AssistantMessage, Context, Message } from './types.ts';

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function estimateMessageTokens(m: Message): number {
  let n = 4;
  for (const c of m.content) {
    if (c.type === 'text') n += estimateTextTokens(c.text);
    else if (c.type === 'image') n += 1200;
    else if (c.type === 'thinking') n += estimateTextTokens(c.text) + (c.signature ? 20 : 0);
    else n += estimateTextTokens(c.name) + estimateTextTokens(JSON.stringify(c.args)) + 8;
  }
  return n;
}

export function estimateContextTokens(context: Context): number {
  let n = 0;
  for (const b of context.system) n += estimateTextTokens(b.text);
  for (const t of context.tools ?? []) n += estimateTextTokens(t.name + t.description + JSON.stringify(t.parameters)) + 10;
  for (const m of context.messages) n += estimateMessageTokens(m);
  return n;
}

export function usageTotal(m: AssistantMessage): number {
  const u = m.usage;
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

export function contextTokens(messages: Message[], baseline: number, usableSince = 0): number {
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.ts >= usableSince && m.stopReason !== 'error' && m.stopReason !== 'aborted' && usageTotal(m) > 0) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return baseline + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  let n = usageTotal(messages[lastIdx] as AssistantMessage);
  for (let i = lastIdx + 1; i < messages.length; i++) n += estimateMessageTokens(messages[i]);
  return n;
}
