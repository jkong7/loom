import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAgent, echoTool } from '../helpers/agent.ts';
import { ToolRegistry, type Tool } from '../../src/agent/tool.ts';
import { PermissionPolicy } from '../../src/agent/permissions.ts';
import { HookBus } from '../../src/agent/hooks.ts';
import { Session } from '../../src/agent/session.ts';
import type { Context } from '../../src/ai/index.ts';

const lastToolText = (ctx: Context) => {
  const m = ctx.messages[ctx.messages.length - 1];
  return m.role === 'tool' ? (m.content[0] as any).text : '';
};

test('plain reply is streamed, returned and persisted as clean JSONL', async () => {
  const { agent, events } = makeAgent([{ text: 'Hello there.' }]);
  const r = await agent.prompt('hi');
  assert.equal(r.reason, 'done');
  assert.equal(r.text, 'Hello there.');
  assert.ok(events.some((e) => e.type === 'message_update' && e.event.type === 'text_delta'));
  const lines = readFileSync(agent.session.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[0].harness, 'loom');
  const msgs = lines.filter((l) => l.type === 'message');
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [['user', 'hi'], ['assistant', 'Hello there.']]);
  for (const m of msgs) {
    assert.equal(m.session_id, agent.session.id);
    assert.equal(m.cwd, agent.cwd);
    assert.ok(Date.parse(m.ts));
  }
});

test('tool calls run, results feed back, and parallel reads keep call order', async () => {
  const order: string[] = [];
  const slow: Tool<{ text: string }> = { ...echoTool('slow'), execute: async (a) => (await new Promise((r) => setTimeout(r, 30)), order.push('slow'), `slow:${a.text}`) };
  const fast: Tool<{ text: string }> = { ...echoTool('fast'), execute: async (a) => (order.push('fast'), `fast:${a.text}`) };
  const tools = new ToolRegistry().register(slow).register(fast);
  const { agent, script } = makeAgent(
    [
      { text: 'Looking.', toolCalls: [{ name: 'slow', args: { text: 'a' } }, { name: 'fast', args: { text: 'b' } }] },
      (ctx) => ({ text: `got ${ctx.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text).join(',')}` }),
    ],
    { tools },
  );
  const r = await agent.prompt('go');
  assert.equal(r.text, 'got slow:a,fast:b');
  assert.deepEqual(order, ['fast', 'slow']);
  assert.equal(r.turns, 2);
  assert.equal(script.calls[0].tools?.length, 2);
});

test('invalid args and unknown tools come back as tool errors', async () => {
  const { agent } = makeAgent([
    { toolCalls: [{ name: 'echo', args: { wrong: 1 } }, { name: 'nope', args: {} }] },
    (ctx) => ({ text: ctx.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text.split('\n')[0]).join(' | ') }),
  ]);
  const r = await agent.prompt('go');
  assert.match(r.text, /Invalid arguments for echo/);
  assert.match(r.text, /Unknown tool "nope"/);
});

test('edits are denied in headless mode without an approver; asker approves interactively', async () => {
  const writeTool: Tool<{ path: string }> = { name: 'write', description: 'w', kind: 'edit', parameters: { type: 'object', properties: { path: { type: 'string' } } }, target: (a) => ({ kind: 'edit', paths: [a.path] }), execute: async () => 'written' };
  const tools = new ToolRegistry().register(writeTool);
  const a = makeAgent([{ toolCalls: [{ name: 'write', args: { path: 'x.txt' } }] }, (ctx) => ({ text: lastToolText(ctx) })], { tools });
  const r1 = await a.agent.prompt('write it');
  assert.match(r1.text, /Permission denied/);

  const asked: string[] = [];
  const b = makeAgent([{ toolCalls: [{ name: 'write', args: { path: 'x.txt' } }] }, (ctx) => ({ text: lastToolText(ctx) })], {
    tools,
    permissions: new PermissionPolicy({ asker: async (req) => (asked.push(req.tool), 'allow') }),
  });
  const r2 = await b.agent.prompt('write it');
  assert.equal(r2.text, 'written');
  assert.deepEqual(asked, ['write']);

  const c = makeAgent([{ toolCalls: [{ name: 'write', args: { path: 'x.txt' } }] }, (ctx) => ({ text: lastToolText(ctx) })], { tools, permissions: new PermissionPolicy({ mode: 'acceptEdits' }) });
  assert.equal((await c.agent.prompt('go')).text, 'written');
  const d = makeAgent([{ toolCalls: [{ name: 'write', args: { path: 'x.txt' } }] }, (ctx) => ({ text: lastToolText(ctx) })], { tools, permissions: new PermissionPolicy({ mode: 'plan' }) });
  assert.match((await d.agent.prompt('go')).text, /plan mode/);
});

test('hooks: prompt context, tool blocking, input rewrite and stop continuation', async () => {
  const hooks = new HookBus();
  const seen: string[] = [];
  hooks.on('SessionStart', () => ({ additionalContext: ['session note'] }));
  hooks.on('UserPromptSubmit', (i) => ({ additionalContext: [`about: ${i.prompt}`] }));
  hooks.on('PreToolUse', (i) => {
    seen.push(String(i.tool_name));
    if ((i.tool_input as any).text === 'bad') return { block: true, reason: 'no bad', decision: 'deny' };
    return { updatedInput: { text: 'rewritten' } };
  });
  let stops = 0;
  hooks.on('Stop', () => (++stops === 1 ? { block: true, reason: 'run the checks' } : {}));
  const { agent, script } = makeAgent(
    [
      { toolCalls: [{ name: 'echo', args: { text: 'bad' } }, { name: 'echo', args: { text: 'ok' } }] },
      (ctx) => ({ text: ctx.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text).join('|') }),
      { text: 'checked' },
    ],
    { hooks },
  );
  const r = await agent.prompt('do it');
  assert.equal(r.text, 'checked');
  const first = script.calls[0];
  assert.match(first.system.map((b) => b.text).join('\n'), /session note/);
  const userContent = (first.messages[0] as any).content;
  assert.match(userContent[0].text, /<system-reminder>\nabout: do it/);
  assert.equal(userContent[1].text, 'do it');
  const second = script.calls[1];
  const toolTexts = second.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text);
  assert.deepEqual(toolTexts, ['Blocked by hook: no bad', 'echo:rewritten']);
  const third = script.calls[2];
  assert.match(JSON.stringify(third.messages.at(-1)), /run the checks/);
  assert.equal(stops, 2);
});

test('steering messages are injected after the current tool batch', async () => {
  let agentRef: any;
  const tool: Tool<{ text: string }> = { ...echoTool(), execute: async (a) => (agentRef.steer('also do Y'), `echo:${a.text}`) };
  const { agent, script } = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { text: 'did X and Y' }], { tools: new ToolRegistry().register(tool) });
  agentRef = agent;
  await agent.prompt('do X');
  const msgs = script.calls[1].messages;
  assert.equal(msgs.at(-1)!.role, 'user');
  assert.equal((msgs.at(-1) as any).content[0].text, 'also do Y');
  assert.equal(msgs.at(-2)!.role, 'tool');
});

test('tool calls from a length-truncated response are not executed', async () => {
  let ran = 0;
  const tool: Tool<{ text: string }> = { ...echoTool(), execute: async () => (ran++, 'x') };
  const { agent } = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }], stop: 'length' }, (ctx) => ({ text: lastToolText(ctx) })], { tools: new ToolRegistry().register(tool) });
  const r = await agent.prompt('go');
  assert.equal(ran, 0);
  assert.match(r.text, /output token limit/);
});

test('repeated identical calls get a loop warning', async () => {
  const call = { name: 'echo', args: { text: 'same' } };
  const { agent } = makeAgent([{ toolCalls: [call] }, { toolCalls: [call] }, { toolCalls: [call] }, (ctx) => ({ text: lastToolText(ctx) + (ctx.messages.at(-1) as any).content.map((c: any) => c.text).join('') })]);
  const r = await agent.prompt('go');
  assert.match(r.text, /exact echo call 3 times/);
});

test('large tool output is truncated head+tail and spilled to a file', async () => {
  const big = 'A'.repeat(50000) + 'END';
  const tool: Tool<{ text: string }> = { ...echoTool(), execute: async () => big };
  const { agent } = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, (ctx) => ({ text: lastToolText(ctx) })], { tools: new ToolRegistry().register(tool), toolOutputMaxChars: 1000 });
  const r = await agent.prompt('go');
  assert.ok(r.text.length < 2000);
  assert.ok(r.text.endsWith('END'));
  const file = r.text.match(/saved to (\S+\.txt)/)![1];
  assert.equal(readFileSync(file, 'utf8'), big);
});

test('abort stops the run and leaves a resumable transcript', async () => {
  const { agent } = makeAgent([{ text: 'x'.repeat(200), delayMs: 300 }]);
  const p = agent.prompt('go');
  setTimeout(() => agent.abort(), 20);
  const r = await p;
  assert.equal(r.reason, 'aborted');
  const reopened = Session.open(agent.session.path);
  assert.equal(reopened.messages()[0].role, 'user');
});

test('model errors end the run with the error text', async () => {
  const { agent } = makeAgent([{ error: 'upstream exploded' }]);
  const r = await agent.prompt('go');
  assert.equal(r.reason, 'error');
  assert.match(r.error!, /upstream exploded/);
});

test('max turns cap', async () => {
  const call = (i: number) => ({ toolCalls: [{ name: 'echo', args: { text: String(i) } }] });
  const { agent } = makeAgent([call(1), call(2), call(3), call(4)], { maxTurns: 2 });
  const r = await agent.prompt('go');
  assert.equal(r.reason, 'max_turns');
});

test('follow-up queue runs after the current prompt finishes', async () => {
  const { agent, script } = makeAgent([{ text: 'first' }, { text: 'second' }]);
  agent.followUp('then this');
  const r = await agent.prompt('start');
  assert.equal(r.text, 'second');
  assert.equal(script.calls.length, 2);
});

test('queued steering and follow-ups are dropped when a run ends badly', async () => {
  let agentRef: any;
  const tool: Tool<{ text: string }> = { ...echoTool(), execute: async () => (agentRef.steer('late steer'), agentRef.followUp('late follow-up'), 'x') };
  const { agent, script, events } = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'x' } }] }, { error: 'boom' }, { text: 'clean' }], { tools: new ToolRegistry().register(tool) });
  agentRef = agent;
  const r1 = await agent.prompt('first');
  assert.equal(r1.reason, 'error');
  assert.ok(events.some((e) => e.type === 'notice' && /dropped 1 queued/.test(e.text)));
  const r2 = await agent.prompt('second');
  assert.equal(r2.text, 'clean');
  assert.equal(script.calls.length, 3);
  assert.ok(!JSON.stringify(script.calls.at(-1)!.messages).includes('late follow-up'));
});
