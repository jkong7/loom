import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAgent } from '../helpers/agent.ts';
import { extractToolCalls, toShimContext, type Context } from '../../src/ai/index.ts';

test('extractToolCalls pulls calls out of text, tolerating fences and a missing close tag', () => {
  const r = extractToolCalls('Let me look.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>\n<tool_call>```json\n{"name":"grep","arguments":{"pattern":"x"}}\n```</tool_call>\n<tool_call>{"name":"glob","arguments":{"pattern":"*.md"}}');
  assert.equal(r.text, 'Let me look.');
  assert.deepEqual(r.calls.map((c) => [c.name, c.args]), [['read', { path: 'a.ts' }], ['grep', { pattern: 'x' }], ['glob', { pattern: '*.md' }]]);
});

test('models without native tool calling use the text shim end to end', async () => {
  const { agent, script } = makeAgent(
    [
      { text: 'Checking.\n<tool_call>{"name":"echo","arguments":{"text":"shimmed"}}</tool_call>' },
      (ctx: Context) => ({ text: `final: ${(ctx.messages.at(-1) as any).content[0].text}` }),
    ],
  );
  agent.model.tools = false;
  const deltas: string[] = [];
  agent.subscribe((e) => {
    if (e.type === 'message_update' && e.event.type === 'text_delta') deltas.push(e.event.delta);
  });
  const r = await agent.prompt('go');
  assert.match(r.text, /^final: <tool_result name="echo">\necho:shimmed/);
  assert.equal(script.calls[0].tools, undefined);
  assert.match(script.calls[0].system.map((b) => b.text).join('\n'), /To call one, write a tool call block/);
  assert.ok(!deltas.join('').includes('<tool_call>'));
  const stored = agent.session.messages()[1] as any;
  assert.deepEqual(stored.content.map((c: any) => c.type), ['text', 'toolCall']);
  const shimmed = toShimContext({ system: [{ text: 's' }], messages: agent.session.messages(), tools: [] });
  assert.equal(shimmed.messages[2].role, 'user');
});
