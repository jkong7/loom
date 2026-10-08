import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMessages, sanitizeToolId, ModelRegistry, parseToolArgs, type Message, type AssistantMessage } from '../../src/ai/index.ts';

const reg = new ModelRegistry();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const asst = (content: AssistantMessage['content'], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({ role: 'assistant', content, provider: 'anthropic', model: 'claude-opus-5-5', api: 'anthropic-messages', usage, stopReason: 'toolUse', ts: 1, ...extra });

test('orphaned tool calls get synthetic error results and stray results are dropped', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }], ts: 0 },
    asst([{ type: 'toolCall', id: 'a', name: 'read', args: {} }, { type: 'toolCall', id: 'b', name: 'bash', args: {} }]),
    { role: 'tool', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, ts: 2 },
    { role: 'tool', toolCallId: 'zzz', toolName: 'read', content: [{ type: 'text', text: 'stray' }], isError: false, ts: 2 },
    { role: 'user', content: [{ type: 'text', text: 'next' }], ts: 3 },
  ];
  const out = prepareMessages(msgs, reg.resolve('anthropic/claude-opus-5-5'));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  const synthetic = out[3] as any;
  assert.equal(synthetic.toolCallId, 'b');
  assert.equal(synthetic.isError, true);
});

test('thinking is kept for the same model and dropped across providers', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }], ts: 0 },
    asst([{ type: 'thinking', text: 'hmm', signature: 'S' }, { type: 'text', text: 'answer' }], { stopReason: 'stop' }),
  ];
  const same = prepareMessages(msgs, reg.resolve('anthropic/claude-opus-5-5'));
  assert.equal((same[1] as AssistantMessage).content.length, 2);
  const other = prepareMessages(msgs, reg.resolve('openai/gpt-5'));
  assert.deepEqual((other[1] as AssistantMessage).content.map((c) => c.type), ['text']);
});

test('errored or aborted assistant turns lose tool calls; empty ones vanish', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }], ts: 0 },
    asst([{ type: 'toolCall', id: 'a', name: 'read', args: {} }], { stopReason: 'aborted' }),
    asst([{ type: 'text', text: 'partial' }, { type: 'toolCall', id: 'b', name: 'read', args: {} }], { stopReason: 'error' }),
  ];
  const out = prepareMessages(msgs, reg.resolve('anthropic/claude-opus-5-5'));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual((out[1] as AssistantMessage).content, [{ type: 'text', text: 'partial' }]);
});

test('images become placeholders for text-only models', () => {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }], ts: 0 }];
  const out = prepareMessages(msgs, reg.resolve('ollama/qwen3:8b'));
  assert.equal((out[0] as any).content[0].type, 'text');
});

test('tool ids are sanitized deterministically and capped', () => {
  assert.equal(sanitizeToolId('call|abc.def'), 'call_abc_def');
  const long = 'x'.repeat(100);
  assert.equal(sanitizeToolId(long).length, 64);
  assert.equal(sanitizeToolId(long), sanitizeToolId(long));
  assert.notEqual(sanitizeToolId(long), sanitizeToolId(long + 'y'));
});

test('tool argument parsing repairs truncated JSON', () => {
  assert.deepEqual(parseToolArgs('{"a":1}').args, { a: 1 });
  assert.deepEqual(parseToolArgs('{"a":"x').args, { a: 'x' });
  assert.deepEqual(parseToolArgs('').args, {});
  assert.ok(parseToolArgs('[1,2]').error);
});

test('registry resolves aliases, provider/model specs and unknown models', () => {
  assert.equal(reg.resolve('sonnet').id, 'claude-sonnet-5-5');
  const m = reg.resolve('openrouter/meta-llama/llama-4-maverick');
  assert.equal(m.provider, 'openrouter');
  assert.equal(m.id, 'meta-llama/llama-4-maverick');
  assert.equal(m.api, 'openai-chat');
  assert.throws(() => reg.resolve('nonsense-model'));
});
