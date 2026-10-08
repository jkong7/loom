import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { startServer } from '../helpers/http.ts';
import { makeAgent, tempDir } from '../helpers/agent.ts';
import { EngramProvider } from '../../src/memory/engram.ts';
import { MemoryManager } from '../../src/memory/manager.ts';
import type { Context } from '../../src/ai/index.ts';

test('engram over REST: digest, recall, turn capture, compaction flush and session end use the hook contract', async () => {
  const calls: { path: string; body: any; auth?: string }[] = [];
  const srv = await startServer((req, res) => {
    calls.push({ path: req.url, body: req.body, auth: req.headers.authorization as string });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') return void res.end(JSON.stringify({ ok: true }));
    if (req.url === '/v1/hooks/loom/SessionStart') return void res.end(JSON.stringify({ context: '<engram-memory>\n- prefers tea\n</engram-memory>', additionalContext: '<engram-memory>\n- prefers tea\n</engram-memory>' }));
    if (req.url === '/v1/hooks/loom/UserPromptSubmit') return void res.end(JSON.stringify(req.body.prompt.includes('drink') ? { additionalContext: '<memory-context source="engram">\n- [m1] likes oolong\n</memory-context>' } : {}));
    if (req.url === '/mcp') {
      res.statusCode = 404;
      return void res.end('{}');
    }
    res.end('{}');
  });
  const home = tempDir();
  writeFileSync(join(home, 'token'), 'secret-token\n');
  const provider = new EngramProvider({ url: srv.url, home, cli: [] as unknown as string[], toolTransport: 'rest' });
  const memory = new MemoryManager([provider]);
  const filler = 'words '.repeat(400);
  const { agent, script } = makeAgent([{ text: 'Oolong.' }, { text: `reply ${filler}` }, { text: `reply ${filler}` }], { memory, contextWindow: 3000, compaction: { keepRecentTokens: 200, reserveTokens: 500 } });
  script.fallback = (ctx: Context) => ({ text: ctx.system[0].text.includes('checkpoint') ? '## Goal\nsummary' : 'ok' });
  try {
    await agent.prompt('what should I drink?');
    await agent.prompt(`second ${filler}`);
    await agent.prompt(`third ${filler}`);
    await agent.close('exit');
    const first = script.calls[0];
    assert.match(first.system.at(-1)!.text, /<engram-memory>\n- prefers tea/);
    assert.match((first.messages[0] as any).content[0].text, /likes oolong/);
    assert.ok(first.tools!.some((t) => t.name === 'memory_search'));
    const paths = calls.map((c) => c.path);
    const hookSeq = paths.filter((p) => p.startsWith('/v1/hooks/')).map((p) => p.split('/').pop());
    assert.deepEqual(hookSeq.slice(0, 3), ['SessionStart', 'UserPromptSubmit', 'Stop']);
    assert.ok(hookSeq.includes('PreCompact'));
    const pre = hookSeq.indexOf('PreCompact');
    assert.ok(hookSeq.indexOf('PostCompact') > pre);
    assert.equal(hookSeq.at(-1), 'SessionEnd');
    assert.ok(paths.includes('/v1/ingest'));
    const ingest = calls.find((c) => c.path === '/v1/ingest')!;
    assert.equal(ingest.body.harness, 'loom');
    assert.ok(ingest.body.turns.every((t: any) => (t.role === 'user' || t.role === 'assistant') && t.text && t.ts));
    const stop = calls.find((c) => c.path.endsWith('/Stop'))!;
    assert.equal(stop.body.session_id, agent.session.id);
    assert.equal(stop.body.transcript_path, agent.session.path);
    assert.equal(stop.body.prompt, 'what should I drink?');
    assert.equal(stop.body.last_assistant_message, 'Oolong.');
    assert.ok(calls.filter((c) => c.path !== '/healthz').every((c) => c.auth === 'Bearer secret-token'));
    const afterCompact = calls.filter((c) => c.path.endsWith('/SessionStart')).map((c) => c.body.source);
    assert.deepEqual(afterCompact.slice(0, 2), ['startup', 'compact']);
  } finally {
    await srv.close();
  }
});

test('engram unreachable and no CLI: hooks spool to ~/.engram/spool in the daemon replay format', async () => {
  const home = tempDir();
  const provider = new EngramProvider({ url: 'http://127.0.0.1:9', home, cli: [] as unknown as string[] });
  const memory = new MemoryManager([provider]);
  const { agent } = makeAgent([{ text: 'fine' }], { memory });
  await agent.prompt('hello there friend');
  await agent.close();
  const spoolDir = join(home, 'spool');
  const lines = readFileSync(join(spoolDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  assert.ok(lines.every((l) => l.harness === 'loom' && l.input.session_id === agent.session.id));
});

const ENGRAM_BIN = join(homedir(), 'dev', 'engram', 'bin', 'engram.js');

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

test('real engram daemon and CLI fallback', { skip: !existsSync(ENGRAM_BIN) && 'engram not checked out at ~/dev/engram' }, async () => {
  const home = tempDir('engram-home-');
  const empty = tempDir('engram-empty-');
  const port = await freePort();
  const env = { ...process.env, ENGRAM_HOME: home, ENGRAM_PORT: String(port), ENGRAM_EMBED: 'off', ENGRAM_LLM: 'none', ENGRAM_CLAUDE_PROJECTS: empty, ENGRAM_CODEX_SESSIONS: empty };
  const cli = (...args: string[]) => spawnSync(process.execPath, [ENGRAM_BIN, ...args], { env, encoding: 'utf8' });
  cli('add', '--kind', 'preference', 'Jonny writes TypeScript with no code comments');
  cli('add', '--kind', 'reference', 'The quarterly billing dashboard lives at grafana.internal/billing');
  const saved = { ...process.env };
  Object.assign(process.env, env, { ENGRAM_BIN });
  let daemon: ChildProcess | undefined;
  try {
    daemon = spawn(process.execPath, [ENGRAM_BIN, 'daemon', 'run', '--quiet'], { env, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 150));
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    }
    assert.ok(up, 'engram daemon came up');
    const cwd = tempDir('loom-proj-');
    mkdirSync(join(cwd, '.git'));
    const provider = new EngramProvider({ url: `http://127.0.0.1:${port}`, home });
    const memory = new MemoryManager([provider]);
    const { agent, script } = makeAgent(
      [
        { toolCalls: [{ name: 'memory_write', args: { text: 'The staging database for the loom integration test is called pelican', kind: 'fact' } }] },
        (ctx: Context) => ({ text: `saved: ${JSON.stringify((ctx.messages.at(-1) as any).content).slice(0, 200)}` }),
        { text: 'It is pelican.' },
        { toolCalls: [{ name: 'memory_search', args: { query: 'staging database pelican' } }] },
        (ctx: Context) => ({ text: (ctx.messages.at(-1) as any).content[0].text }),
      ],
      { memory, cwd },
    );
    const r1 = await agent.prompt('remember that our staging database is called pelican');
    assert.match(script.calls[0].system.at(-1)!.text, /no code comments/);
    assert.match(script.calls[0].system.at(-1)!.text, /grafana\.internal\/billing/);
    assert.match(r1.text, /saved/);
    await agent.prompt('what is the staging database called again?');
    const recall = (script.calls[2].messages.at(-1) as any).content[0];
    assert.equal(recall.meta, 'memory');
    assert.match(recall.text, /^<memory-context source="engram">/);
    assert.match(recall.text, /pelican/);
    assert.deepEqual(script.calls[2].system, script.calls[0].system);
    const r2 = await agent.prompt('search memory for the staging database');
    assert.match(r2.text, /pelican/);
    assert.equal(provider.status().transport.startsWith('rest'), true);
    await agent.close('exit');
    const token = readFileSync(join(home, 'token'), 'utf8').trim();
    const sessions = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    const mine = sessions.sessions.find((s: any) => s.key === `loom:${agent.session.id}`);
    assert.ok(mine, 'session recorded under harness loom');
    assert.ok(mine.turn_count >= 4);

    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    const offline = new EngramProvider({ url: `http://127.0.0.1:${port}`, home, toolTransport: 'mcp-stdio' });
    const memory2 = new MemoryManager([offline], { prefetchTimeoutMs: 15000, hookTimeoutMs: 15000 });
    const b = makeAgent([{ toolCalls: [{ name: 'memory_search', args: { query: 'pelican' } }] }, (ctx: Context) => ({ text: (ctx.messages.at(-1) as any).content[0].text })], { memory: memory2, cwd });
    const r3 = await b.agent.prompt('what is the staging database called?');
    assert.match(b.script.calls[0].system.at(-1)!.text, /no code comments/);
    assert.match(r3.text, /pelican/);
    assert.match(offline.status().transport, /^cli, tools via mcp-stdio/);
    await b.agent.close('exit');
  } finally {
    daemon?.kill('SIGKILL');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('each agent gets its own engram provider, so closing one session does not break the next', async () => {
  const sessions: string[] = [];
  const srv = await startServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') return void res.end(JSON.stringify({ ok: true }));
    if (req.url?.startsWith('/v1/hooks/loom/')) sessions.push(`${req.url.split('/').pop()}:${req.body.session_id}`);
    if (req.url === '/v1/search') return void res.end(JSON.stringify({ memories: [{ id: 'm1', kind: 'fact', title: 't', body: 'found it' }] }));
    if (req.url === '/mcp') {
      res.statusCode = 404;
      return void res.end('{}');
    }
    res.end('{}');
  });
  const { Runtime } = await import('../../src/runtime.ts');
  const { ModelRegistry, MockScript, setMockScript } = await import('../../src/ai/index.ts');
  const id = `engram-rt-${Date.now()}`;
  setMockScript(id, new MockScript([{ text: 'a' }, { toolCalls: [{ name: 'memory_search', args: { query: 'x' } }] }, (ctx: Context) => ({ text: (ctx.messages.at(-1) as any).content[0].text })]));
  const registry = new ModelRegistry();
  registry.addModel({ provider: 'mock', id });
  const home = tempDir();
  const rt = await Runtime.create({ cwd: tempDir(), home: tempDir(), registry, model: `mock/${id}`, mcp: false, config: { memory: { provider: 'engram', engram: { url: srv.url, home, cli: [] as unknown as string[], toolTransport: 'rest' } } } });
  try {
    const a = await rt.createAgent();
    await a.prompt('first session');
    await a.close('switch');
    const b = await rt.createAgent();
    const r = await b.prompt('second session');
    assert.match(r.text, /found it/);
    await b.close('exit');
    const ends = sessions.filter((s) => s.startsWith('SessionEnd:'));
    assert.deepEqual(ends, [`SessionEnd:${a.session.id}`, `SessionEnd:${b.session.id}`]);
    assert.ok(sessions.includes(`Stop:${b.session.id}`));
  } finally {
    await rt.close();
    await srv.close();
  }
});
