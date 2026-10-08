import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, HELP, type CliArgs } from './args.ts';
import { Runtime } from '../runtime.ts';
import { TextRenderer, toStreamJson, c } from './render.ts';
import { Tui } from './tui.ts';
import { LoomServer, PermissionBroker } from '../server/http.ts';
import { runRpc } from '../server/rpc.ts';
import { EngramProvider, findEngramCli } from '../memory/engram.ts';
import { findRipgrep } from '../tools/search.ts';
import type { ReasoningLevel } from '../ai/types.ts';
import type { LoomConfig } from '../config.ts';
import type { Asker } from '../agent/permissions.ts';

const VERSION = '0.1.0';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function overrides(a: CliArgs): LoomConfig {
  const o: LoomConfig = {};
  if (a.maxTurns) o.maxTurns = a.maxTurns;
  if (a.sandbox) o.sandbox = { mode: 'seatbelt', network: true };
  if (a.systemAppend) o.systemPrompt = { append: a.systemAppend };
  if (a.allow.length || a.deny.length) o.permissions = { allow: a.allow, deny: a.deny };
  return o;
}

async function makeRuntime(a: CliArgs, asker?: Asker): Promise<Runtime> {
  return Runtime.create({
    cwd: a.cwd ? resolve(a.cwd) : process.cwd(),
    config: overrides(a),
    model: a.model,
    mode: a.mode,
    asker,
    memory: a.memory ? undefined : false,
    mcp: a.mcp,
    onWarning: a.verbose ? (t) => process.stderr.write(c.yellow(`warning: ${t}\n`)) : undefined,
  });
}

function sessionOpts(a: CliArgs) {
  return {
    resume: a.continue ? ('latest' as const) : a.resume === true ? ('latest' as const) : a.resume,
    fork: a.fork ? { session: a.fork } : undefined,
    reasoning: a.reasoning as ReasoningLevel | undefined,
  };
}

async function printMode(a: CliArgs): Promise<number> {
  const stdin = a.prompt ? '' : await readStdin();
  const prompt = [a.prompt, stdin.trim()].filter(Boolean).join('\n\n');
  if (!prompt) {
    process.stderr.write('loom -p needs a prompt (argument or stdin)\n');
    return 2;
  }
  const rt = await makeRuntime(a);
  const agent = await rt.createAgent({ ...sessionOpts(a), agentContext: 'headless' });
  let code = 0;
  try {
    if (a.outputFormat === 'stream-json') {
      agent.subscribe((e) => {
        const j = toStreamJson(e, agent.session.id);
        if (j) process.stdout.write(JSON.stringify(j) + '\n');
      });
    } else if (a.outputFormat === 'text' && a.verbose) {
      const r = new TextRenderer(process.stderr, true);
      agent.subscribe((e) => r.handle(e));
    }
    const r = await agent.prompt(prompt);
    code = r.reason === 'done' ? 0 : 1;
    if (a.outputFormat === 'text') {
      process.stdout.write(r.text + (r.text.endsWith('\n') ? '' : '\n'));
      if (r.reason !== 'done') process.stderr.write(`loom: ${r.reason}${r.error ? `: ${r.error}` : ''}\n`);
    } else {
      const result = { type: 'result', session_id: agent.session.id, reason: r.reason, is_error: r.reason !== 'done', result: r.text, error: r.error, turns: r.turns, usage: r.usage, model: `${agent.model.provider}/${agent.model.id}`, transcript_path: agent.session.path };
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } finally {
    await rt.close();
  }
  return code;
}

async function doctor(a: CliArgs): Promise<number> {
  const rt = await makeRuntime({ ...a, memory: false });
  const ok = (b: boolean) => (b ? c.green('ok ') : c.yellow('-- '));
  const line = (b: boolean, s: string) => process.stdout.write(`${ok(b)} ${s}\n`);
  process.stdout.write(c.bold(`loom ${VERSION} doctor\n`));
  line(true, `node ${process.version}, cwd ${rt.cwd}`);
  line(rt.configFiles.length > 0, `config files: ${rt.configFiles.join(', ') || 'none (defaults)'}`);
  for (const p of rt.registry.listProviders()) {
    if (p.id === 'mock') continue;
    const key = (p.apiKeyEnv ?? []).find((e) => process.env[e]);
    if (p.apiKeyOptional) continue;
    line(!!key, `${p.id}: ${key ? `key from ${key}` : `no key (${(p.apiKeyEnv ?? []).join(' or ')})`}`);
  }
  for (const id of ['ollama', 'lmstudio', 'vllm']) {
    const p = rt.registry.provider(id)!;
    const base = p.baseUrl.replace(/\/v1$/, '');
    const up = await fetch(id === 'ollama' ? `${base}/api/tags` : `${p.baseUrl}/models`, { signal: AbortSignal.timeout(800) }).then(async (r) => (r.ok ? await r.json() : null), () => null);
    const models = up ? (up.models ?? up.data ?? []).map((m: any) => m.name ?? m.id).slice(0, 8).join(', ') : '';
    line(!!up, `${id} at ${p.baseUrl}: ${up ? `up (${models || 'no models'})` : 'not reachable'}`);
  }
  try {
    const m = rt.resolveModel();
    line(true, `default model: ${m.provider}/${m.id}`);
  } catch (err) {
    line(false, `default model: ${(err as Error).message}`);
  }
  const engram = new EngramProvider(rt.config.memory?.engram);
  const up = await engram.healthy();
  const cli = findEngramCli();
  line(up || !!cli, `engram: daemon ${up ? `up at ${engram.opts.url}` : 'down'}, CLI ${cli ? cli.join(' ') : 'not found (set ENGRAM_BIN or put engram on PATH)'}`);
  line(!!findRipgrep(), `ripgrep: ${findRipgrep() ?? 'not found (grep falls back to a slower JS search)'}`);
  line(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'), `seatbelt sandbox: ${process.platform === 'darwin' ? 'available' : 'macOS only'}`);
  for (const s of rt.mcp.status.values()) line(s.connected, `mcp ${s.name}: ${s.connected ? `${s.tools} tools` : s.error}`);
  line(true, `skills: ${rt.skills.map((s) => s.name).join(', ') || 'none'}; agents: ${rt.agentDefs.map((d) => d.name).join(', ')}`);
  for (const w of rt.warnings) line(false, w);
  await rt.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let a: CliArgs;
  try {
    a = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  if (a.help || a.command === 'help') return void process.stdout.write(HELP + '\n'), 0;
  if (a.version || a.command === 'version') return void process.stdout.write(VERSION + '\n'), 0;
  if (a.print) return printMode(a);
  switch (a.command) {
    case 'doctor':
      return doctor(a);
    case 'models': {
      const rt = await makeRuntime({ ...a, memory: false, mcp: false });
      for (const m of rt.registry.list()) process.stdout.write(`${`${m.provider}/${m.id}`.padEnd(44)} ${String(m.contextWindow).padStart(8)} ctx  ${m.reasoning ? 'reasoning ' : ''}${m.input.includes('image') ? 'vision ' : ''}${m.tools ? 'tools' : ''}\n`);
      process.stdout.write(c.gray(`\naliases: ${Object.entries(rt.registry.aliases).map(([k, v]) => `${k}=${v}`).join(', ')}\nAny provider/model works even if unlisted, for example ollama/llama3.2 or openrouter/x-ai/grok-4.\n`));
      await rt.close();
      return 0;
    }
    case 'sessions': {
      const rt = await makeRuntime({ ...a, memory: false, mcp: false });
      const list = rt.sessions.list(a.positional[0] === 'all' ? undefined : rt.cwd, 30);
      if (!list.length) process.stdout.write('no sessions yet\n');
      for (const s of list) process.stdout.write(`${s.id.slice(0, 8)}  ${s.updated.slice(0, 16).replace('T', ' ')}  ${String(s.messages).padStart(4)} msgs  ${(s.model ?? '').padEnd(28)} ${s.title ?? ''}\n`);
      await rt.close();
      return 0;
    }
    case 'mcp': {
      const rt = await makeRuntime({ ...a, memory: false });
      for (const s of rt.mcp.status.values()) process.stdout.write(`${s.name}: ${s.connected ? `connected, ${s.tools} tools` : `failed: ${s.error}`}\n`);
      for (const t of rt.tools.list().filter((t) => t.name.startsWith('mcp__'))) process.stdout.write(`  ${t.name}\n`);
      if (!rt.mcp.status.size) process.stdout.write('no MCP servers configured (mcpServers in .loom/config.json or .mcp.json)\n');
      await rt.close();
      return 0;
    }
    case 'serve': {
      const broker = new PermissionBroker();
      const rt = await makeRuntime(a, broker.asker);
      const server = new LoomServer(rt, broker, { port: a.port, host: a.host, token: process.env.LOOM_SERVER_TOKEN });
      const { url } = await server.listen();
      process.stderr.write(`loom server listening on ${url} (cwd ${rt.cwd})\n`);
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => {});
      return 0;
    }
    case 'rpc': {
      const broker = new PermissionBroker();
      const rt = await makeRuntime(a, broker.asker);
      const agent = await rt.createAgent({ ...sessionOpts(a), agentContext: 'headless' });
      await runRpc(rt, broker, agent);
      return 0;
    }
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    a.print = true;
    a.prompt = a.positional.join(' ') || undefined;
    return printMode(a);
  }
  let tui: Tui | undefined;
  const rt = await makeRuntime(a, (req) => tui!.asker(req));
  tui = new Tui(rt, a.verbose);
  tui.attach(await rt.createAgent(sessionOpts(a)));
  await tui.start(a.positional.join(' ') || undefined);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`loom: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
