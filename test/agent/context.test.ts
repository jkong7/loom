import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeAgent, tempDir, echoTool } from '../helpers/agent.ts';
import { Session, SessionStore, PRUNED_MARKER } from '../../src/agent/session.ts';
import { MemoryManager } from '../../src/memory/manager.ts';
import type { MemoryProvider } from '../../src/memory/provider.ts';
import { loadInstructions, renderInstructions } from '../../src/agent/instructions.ts';
import { ToolRegistry, type Tool } from '../../src/agent/tool.ts';
import type { Context } from '../../src/ai/index.ts';

function fakeMemory(log: string[]): MemoryProvider {
  let digestN = 0;
  return {
    name: 'fake',
    isAvailable: async () => true,
    initialize: async (info) => void log.push(`init:${info.source}`),
    systemPromptBlock: async () => `DIGEST v${++digestN}`,
    prefetch: async (q) => (log.push(`prefetch:${q}`), q.includes('tea') ? 'User likes green tea.' : null),
    syncTurn: async (t) => void log.push(`sync:${t.user}->${t.assistant}`),
    onPreCompress: async (e) => (log.push(`precompress:${e.messages.length}`), 'remember the tea'),
    onPostCompress: async () => void log.push('postcompress'),
    onSessionEnd: async (_m, reason) => void log.push(`end:${reason}`),
    tools: () => [{ name: 'memory_search', description: 'search', kind: 'memory', parameters: { type: 'object', properties: {} }, execute: async () => 'none' }],
  };
}

test('memory: frozen digest in system prompt, recall in the user turn, sync after the turn, tools registered', async () => {
  const log: string[] = [];
  const memory = new MemoryManager([fakeMemory(log)]);
  const { agent, script } = makeAgent([{ text: 'noted' }, { text: 'again' }], { memory });
  await agent.prompt('what tea do I like?');
  await agent.prompt('ok');
  await memory.flush();
  const c0 = script.calls[0];
  assert.match(c0.system.at(-1)!.text, /DIGEST v1/);
  assert.equal(c0.system.at(-1)!.cache, true);
  const u = (c0.messages[0] as any).content;
  assert.match(u[0].text, /^<memory-context source="fake">/);
  assert.match(u[0].text, /green tea/);
  assert.equal(u[0].meta, 'memory');
  assert.equal(u[1].text, 'what tea do I like?');
  assert.ok(c0.tools!.some((t) => t.name === 'memory_search'));
  assert.deepEqual(script.calls[1].system, c0.system);
  assert.deepEqual(script.calls[1].messages[0], c0.messages[0]);
  assert.deepEqual(log, ['init:startup', 'prefetch:what tea do I like?', 'sync:what tea do I like?->noted', 'sync:ok->again']);
  const line = agent.session.allEntries().find((e) => e.type === 'message' && e.role === 'user') as any;
  assert.equal(line.text, 'what tea do I like?');
  await agent.close('test');
  assert.equal(log.at(-1), 'end:test');
});

test('compaction: flushes memory first, writes a structured summary, keeps the recent tail, refreshes the digest', async () => {
  const log: string[] = [];
  const memory = new MemoryManager([fakeMemory(log)]);
  const filler = 'lorem ipsum dolor sit amet '.repeat(60);
  const steps: any[] = [];
  for (let i = 0; i < 6; i++) steps.push({ text: `answer ${i} ${filler}` });
  const { agent, script } = makeAgent(steps, { memory, contextWindow: 4000, compaction: { keepRecentTokens: 600, reserveTokens: 1000 } });
  script.push((ctx: Context) => ({ text: `## Goal\nsummary of ${ctx.messages.length} msgs` }));
  script.fallback = () => ({ text: 'after compaction' });
  for (let i = 0; i < 6; i++) await agent.prompt(`question ${i} ${filler}`);
  const r = await agent.prompt('final question');
  assert.equal(r.text, 'after compaction');
  const comp = agent.session.latestCompaction();
  assert.ok(comp, 'compaction entry written');
  assert.match(comp!.summary, /## Goal/);
  const iPre = log.findIndex((l) => l.startsWith('precompress'));
  const iPost = log.indexOf('postcompress');
  assert.ok(iPre >= 0 && iPost > iPre);
  const summaryCall = script.calls.find((c) => c.system[0].text.includes('checkpoint summaries'))!;
  assert.match((summaryCall.messages[0] as any).content[0].text, /remember the tea/);
  const last = script.calls.at(-1)!;
  const compactions = agent.session.allEntries().filter((e) => e.type === 'compaction').length;
  assert.ok(compactions >= 1);
  assert.equal(last.system.at(-1)!.text, `DIGEST v${compactions + 1}`);
  assert.match((last.messages[0] as any).content[0].text, /<conversation-summary>/);
  assert.ok(last.messages.length < 8);
  assert.equal((last.messages.at(-1) as any).content.at(-1).text, 'final question');
  const reopened = Session.open(agent.session.path);
  assert.deepEqual(reopened.contextMessages().map((m) => m.role), agent.session.contextMessages().map((m) => m.role));
});

test('overflow errors trigger compaction and a retry', async () => {
  const { agent, script } = makeAgent([{ text: 'a' }, { error: 'HTTP 400: prompt is too long: 250000 tokens > 200000 maximum' }, { text: '## Goal\ncompacted' }, { text: 'recovered' }]);
  await agent.prompt('one');
  const r = await agent.prompt('two');
  assert.equal(r.text, 'recovered');
  assert.ok(agent.session.latestCompaction());
  assert.equal(script.calls.length, 4);
});

test('pruning happens between prompts: old tool outputs are replaced and earlier thinking is stripped', async () => {
  const big = 'x'.repeat(18000);
  const tool: Tool<{ text: string }> = { ...echoTool(), execute: async () => big };
  const steps: any[] = [];
  for (let i = 0; i < 4; i++) steps.push({ thinking: 'hmm', toolCalls: [{ name: 'echo', args: { text: String(i) } }] }, { text: `done ${i}` });
  steps.push({ thinking: 'fresh', toolCalls: [{ name: 'echo', args: { text: 'last' } }] }, { text: 'final' });
  const { agent, script, events } = makeAgent(steps, { tools: new ToolRegistry().register(tool), toolOutputMaxChars: 100000, contextWindow: 40000, compaction: { thresholdRatio: 0.6, pruneProtectTokens: 9000, pruneMinSavings: 5000, reserveTokens: 2000 } });
  for (let i = 0; i < 4; i++) await agent.prompt(`step ${i}`);
  const r = await agent.prompt(`wrap up ${'context '.repeat(1500)}`);
  assert.equal(r.text, 'final');
  assert.ok(events.some((e) => e.type === 'compaction' && e.phase === 'prune'));
  assert.equal(agent.session.latestCompaction(), undefined);
  const last = script.calls.at(-1)!;
  const tools = last.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text);
  assert.ok(tools.includes(PRUNED_MARKER));
  assert.ok(tools.at(-1)!.length > 1000);
  const thinking = last.messages.filter((m) => m.role === 'assistant').map((m) => (m as any).content.some((c: any) => c.type === 'thinking'));
  assert.equal(thinking.at(-1), true);
  assert.equal(thinking[0], false);
  const raw = agent.session.messages().filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text);
  assert.ok(raw.every((t) => t !== PRUNED_MARKER));
});

test('sessions resume from disk and fork into a new file', async () => {
  const { agent, root } = makeAgent([{ text: 'one' }, { text: 'two' }]);
  await agent.prompt('first');
  await agent.prompt('second');
  const store = new SessionStore(root);
  const list = store.list(agent.cwd);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'first');
  const resumed = store.find(agent.session.id.slice(0, 8))!;
  assert.deepEqual(resumed.messages().map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  const firstAssistant = resumed.branch().find((e) => e.type === 'message' && e.role === 'assistant')!;
  const fork = resumed.fork(root, firstAssistant.id);
  assert.notEqual(fork.id, resumed.id);
  assert.equal(fork.messages().length, 2);
  assert.equal(fork.header.forked_from?.session_id, resumed.id);
  fork.appendMessage({ role: 'user', content: [{ type: 'text', text: 'branch' }], ts: Date.now() });
  assert.equal(Session.open(fork.path).messages().length, 3);
  assert.equal(Session.open(resumed.path).messages().length, 4);
  resumed.rewindTo(firstAssistant.id);
  assert.equal(Session.open(resumed.path).messages().length, 2);
});

test('instruction files load from git root down to cwd with imports', () => {
  const home = tempDir();
  const repo = tempDir();
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'pkg', 'sub'), { recursive: true });
  writeFileSync(join(home, 'AGENTS.md'), 'global rule');
  writeFileSync(join(repo, 'AGENTS.md'), 'root rule\n@docs.md');
  writeFileSync(join(repo, 'docs.md'), 'imported doc');
  writeFileSync(join(repo, 'pkg', 'CLAUDE.md'), 'pkg rule');
  const files = loadInstructions({ cwd: join(repo, 'pkg', 'sub'), home });
  assert.deepEqual(files.map((f) => f.scope), ['global', 'project', 'project']);
  assert.match(files[1].content, /imported doc/);
  assert.match(renderInstructions(files), /pkg rule/);
});
