import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { makeAgent, tempDir } from '../helpers/agent.ts';
import { EngramProvider } from '../../src/memory/engram.ts';
import { MemoryManager } from '../../src/memory/manager.ts';
import { Tracer } from '../../src/telemetry/otel.ts';
import type { Context } from '../../src/ai/index.ts';

const DEV = resolve(import.meta.dirname, '..', '..', '..');
const ENGRAM = process.env.ENGRAM_CHECKOUT ?? join(DEV, 'engram');
const BLACKBOX = process.env.BLACKBOX_CHECKOUT ?? join(DEV, 'blackbox');
const missing = !existsSync(join(ENGRAM, 'bin', 'engram.js')) ? `engram not checked out at ${ENGRAM}` : !existsSync(join(BLACKBOX, 'src', 'cli.ts')) ? `blackbox not checked out at ${BLACKBOX}` : false;

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('loom + engram + blackbox: one distributed trace from the agent loop through engram recall and MCP writes', { skip: missing, timeout: 120000 }, async () => {
  const [ePort, bPort, oPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const eHome = tempDir('stack-engram-');
  const empty = tempDir('stack-empty-');
  const otlp = `http://127.0.0.1:${oPort}`;
  const procs: ChildProcess[] = [];
  const saved = { ...process.env };
  try {
    procs.push(spawn(process.execPath, [join(BLACKBOX, 'src', 'cli.ts'), 'serve'], { env: { ...process.env, BLACKBOX_HOME: tempDir('stack-bb-'), BLACKBOX_PORT: String(bPort), BLACKBOX_OTLP_PORT: String(oPort), BLACKBOX_PROXY_PORT: '0' }, stdio: 'ignore' }));
    const eEnv = { ...process.env, ENGRAM_HOME: eHome, ENGRAM_PORT: String(ePort), ENGRAM_EMBED: 'off', ENGRAM_LLM: 'none', ENGRAM_CLAUDE_PROJECTS: empty, ENGRAM_CODEX_SESSIONS: empty, ENGRAM_OTEL_ENDPOINT: otlp };
    procs.push(spawn(process.execPath, [join(ENGRAM, 'bin', 'engram.js'), 'daemon', 'run', '--quiet'], { env: eEnv, stdio: 'ignore' }));
    const bb = `http://127.0.0.1:${bPort}`;
    await waitFor(async () => ((await fetch(`${bb}/api/health`)).ok ? true : undefined));
    await waitFor(async () => ((await fetch(`http://127.0.0.1:${ePort}/healthz`)).ok ? true : undefined));
    Object.assign(process.env, { ENGRAM_HOME: eHome, ENGRAM_BIN: join(ENGRAM, 'bin', 'engram.js') });

    const cwd = tempDir('stack-proj-');
    mkdirSync(join(cwd, '.git'));
    const memory = new MemoryManager([new EngramProvider({ url: `http://127.0.0.1:${ePort}`, home: eHome })]);
    const tracer = new Tracer({ endpoint: otlp, project: 'stack-e2e', flushIntervalMs: 50 }, { env: {} });
    const { agent } = makeAgent(
      [
        { toolCalls: [{ name: 'memory_write', args: { text: 'The stack-e2e service deploys to the heron cluster', kind: 'fact' } }] },
        { text: 'Saved.' },
        { toolCalls: [{ name: 'memory_search', args: { query: 'which cluster does stack-e2e deploy to' } }] },
        (ctx: Context) => ({ text: /heron/.test(JSON.stringify(ctx.messages.at(-1))) ? 'heron' : 'unknown' }),
      ],
      { memory, tracer, cwd },
    );
    await agent.prompt('remember that stack-e2e deploys to the heron cluster');
    const r = await agent.prompt('which cluster does stack-e2e deploy to?');
    assert.equal(r.text, 'heron');
    await agent.close('exit');
    await tracer.flush();

    const list = await waitFor(async () => {
      const j = await (await fetch(`${bb}/api/traces?project=stack-e2e&window=1h`)).json();
      return j.items.length >= 2 ? j.items : undefined;
    });
    const traces = await Promise.all(list.map(async (t: any) => (await fetch(`${bb}/api/traces/${t.trace_id}`)).json()));
    const write = traces.find((t: any) => t.spans.some((s: any) => s.tool_name === 'memory_write'));
    const read = traces.find((t: any) => t.spans.some((s: any) => s.tool_name === 'memory_search'));
    assert.ok(write && read);

    const span = (t: any, f: (s: any) => boolean) => t.spans.find(f);
    const loomWrite = span(write, (s: any) => s.name === 'execute_tool memory_write');
    const engramWrite = await waitFor(async () => {
      const t = await (await fetch(`${bb}/api/traces/${write.trace.trace_id}`)).json();
      return span(t, (s: any) => s.name === 'create_memory engram' && s.memory_op === 'create');
    });
    assert.equal(loomWrite.kind, 'memory');
    assert.equal(engramWrite.parent_id, loomWrite.span_id, 'engram MCP write nests under the loom tool span');

    const t2 = await waitFor(async () => {
      const t = await (await fetch(`${bb}/api/traces/${read.trace.trace_id}`)).json();
      return span(t, (s: any) => s.name === 'search_memory engram' && s.memory_op === 'recall') ? t : undefined;
    });
    const root = span(t2, (s: any) => !s.parent_id);
    assert.equal(root.kind, 'agent');
    assert.equal(root.session_id, agent.session.id);
    const loomRecall = span(t2, (s: any) => s.memory_op === 'prefetch' && s.parent_id === root.span_id);
    const engramRecall = span(t2, (s: any) => s.name === 'search_memory engram' && s.memory_op === 'recall');
    assert.equal(engramRecall.parent_id, loomRecall.span_id, 'engram recall nests under loom memory prefetch');
    assert.ok(t2.spans.filter((s: any) => s.kind === 'llm').length >= 2);
    const engramSearch = span(t2, (s: any) => s.name === 'search_memory engram' && s.memory_op === 'search');
    assert.equal(span(t2, (s: any) => s.span_id === engramSearch.parent_id).tool_name, 'memory_search');

    const mem = await (await fetch(`${bb}/api/memory?window=1h`)).json();
    const ops = Object.fromEntries(mem.summary.map((o: any) => [o.op, o.n]));
    assert.ok(ops.create >= 1 && ops.recall >= 1 && ops.search >= 1 && ops.capture >= 1, JSON.stringify(ops));
  } finally {
    process.env = saved;
    for (const p of procs) p.kill('SIGTERM');
  }
});
