import { createInterface, type Interface } from 'node:readline';
import type { Agent } from '../agent/agent.ts';
import type { Runtime } from '../runtime.ts';
import type { PermissionAnswer, PermissionRequest } from '../agent/permissions.ts';
import { TextRenderer, c, formatUsage } from './render.ts';
import { textOf } from '../ai/types.ts';

const SLASH_HELP = `Commands
  /help                 this list
  /model [spec]         show or switch the model (provider/model or alias)
  /mode [m]             show or set permission mode: default, acceptEdits, plan, yolo
  /compact [focus]      summarize the conversation now
  /context              token usage and compaction threshold
  /new                  start a fresh session
  /sessions             recent sessions in this directory
  /resume <id>          switch to another session
  /fork                 fork the current session and continue in the copy
  /tools                list tools
  /skills               list skills
  /memory               memory provider status and the current digest
  /usage                tokens and cost so far
  /exit                 quit
While the agent is working, typing a line steers it; Ctrl+C interrupts.`;

export class Tui {
  private rt: Runtime;
  agent!: Agent;
  private rl!: Interface;
  private renderer: TextRenderer;
  private running = false;
  private question: ((answer: string) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastSigint = 0;
  private verbose: boolean;

  constructor(rt: Runtime, verbose = false) {
    this.rt = rt;
    this.verbose = verbose;
    this.renderer = new TextRenderer(process.stdout, verbose);
  }

  asker = (req: PermissionRequest): Promise<PermissionAnswer> => {
    const what = req.target.kind === 'execute' ? `run ${c.bold(String(req.target.subject))}` : req.target.paths?.length ? `${req.tool} ${c.bold(req.target.paths.join(', '))}` : `${req.tool} ${c.bold(String(req.target.subject ?? JSON.stringify(req.args).slice(0, 120)))}`;
    process.stdout.write(`\n${c.yellow('?')} Allow ${what} ${c.gray(`(${req.reason})`)}\n  ${c.bold('y')}es / ${c.bold('n')}o / ${c.bold('a')}lways this session: `);
    return new Promise((resolve) => {
      this.question = (ans) => {
        const a = ans.trim().toLowerCase();
        resolve(a === 'a' || a === 'always' ? 'always' : a === 'y' || a === 'yes' || a === '' ? 'allow' : 'deny');
      };
    });
  };

  attach(agent: Agent): void {
    this.unsubscribe?.();
    this.agent = agent;
    this.unsubscribe = agent.subscribe((e) => this.renderer.handle(e));
  }

  banner(): void {
    const m = this.agent.model;
    const mem = this.agent.memory ? this.agent.memory.status().map((s) => `${s.provider} ${s.healthy ? c.green('on') : c.gray(s.transport || 'off')}`).join(', ') : 'off';
    process.stdout.write(`${c.bold('loom')} ${c.gray('·')} ${m.provider}/${m.id} ${c.gray('·')} ${this.rt.cwd}\n`);
    process.stdout.write(c.gray(`session ${this.agent.session.id.slice(0, 8)} · mode ${this.rt.permissions.mode} · memory ${mem} · /help for commands\n`));
    for (const w of this.rt.warnings) process.stdout.write(c.yellow(`warning: ${w}\n`));
  }

  async start(initial?: string): Promise<void> {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('› '), terminal: true, historySize: 500 });
    await this.agent.start();
    this.banner();
    const history = this.agent.session.messages();
    if (history.length) process.stdout.write(c.gray(`resumed with ${history.length} messages; last: ${textOf(history[history.length - 1].content).slice(0, 120).replace(/\s+/g, ' ')}\n`));
    this.rl.on('SIGINT', () => this.onSigint());
    this.rl.on('line', (line) => void this.onLine(line));
    this.rl.on('close', () => void this.exit());
    if (initial) await this.onLine(initial);
    else this.rl.prompt();
    await new Promise<void>(() => {});
  }

  private onSigint(): void {
    if (this.question) {
      const q = this.question;
      this.question = null;
      process.stdout.write('\n');
      q('n');
      return;
    }
    if (this.running) {
      this.agent.abort();
      process.stdout.write(c.yellow('\n[interrupted]\n'));
      return;
    }
    const now = Date.now();
    if (now - this.lastSigint < 1500) return void this.exit();
    this.lastSigint = now;
    process.stdout.write(c.gray('\n(press Ctrl+C again to exit)\n'));
    this.rl.prompt();
  }

  private async onLine(raw: string): Promise<void> {
    if (this.question) {
      const q = this.question;
      this.question = null;
      q(raw);
      return;
    }
    const line = raw.trim();
    if (!line) {
      if (!this.running) this.rl.prompt();
      return;
    }
    if (this.running) {
      this.agent.steer(line);
      process.stdout.write(c.gray('[queued as steering for the current run]\n'));
      return;
    }
    if (line.startsWith('/')) {
      await this.command(line);
      if (!this.running) this.rl.prompt();
      return;
    }
    this.running = true;
    try {
      const r = await this.agent.prompt(line);
      if (r.reason !== 'done') process.stdout.write(c.gray(`[${r.reason}${r.error ? `: ${r.error}` : ''}]\n`));
      else if (this.verbose) process.stdout.write(c.gray(`[${r.turns} turns · ${formatUsage(r.usage)}]\n`));
    } catch (err) {
      process.stdout.write(c.red(`error: ${(err as Error).message}\n`));
    } finally {
      this.running = false;
      this.rl.prompt();
    }
  }

  private async swap(agent: Agent): Promise<void> {
    await this.agent.close('switch');
    this.attach(agent);
    await agent.start();
    this.banner();
  }

  private async command(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const say = (s: string): void => {
      process.stdout.write(s + '\n');
    };
    try {
      switch (cmd) {
        case 'help':
        case '?':
          return say(SLASH_HELP);
        case 'exit':
        case 'quit':
          return this.exit();
        case 'model':
          if (!arg) return say(`${this.agent.model.provider}/${this.agent.model.id} (context ${this.agent.model.contextWindow}, tools ${this.agent.model.tools}, reasoning ${this.agent.model.reasoning})`);
          this.agent.setModel(this.rt.resolveModel(arg));
          return say(`model is now ${this.agent.model.provider}/${this.agent.model.id}`);
        case 'mode':
          if (arg) this.rt.permissions.mode = arg as never;
          return say(`permission mode: ${this.rt.permissions.mode}`);
        case 'compact': {
          this.running = true;
          const r = await this.agent.compact({ reason: 'manual', instructions: arg || undefined });
          this.running = false;
          return say(c.gray(`compacted ${r.tokensBefore} to about ${r.tokensAfter} tokens`));
        }
        case 'context': {
          const t = this.agent.contextTokens();
          return say(`${t} tokens in context of ${this.agent.model.contextWindow} (${Math.round((t / this.agent.model.contextWindow) * 100)}%)`);
        }
        case 'new':
          return this.swap(await this.rt.createAgent({ model: `${this.agent.model.provider}/${this.agent.model.id}` }));
        case 'sessions': {
          for (const s of this.rt.sessions.list(this.rt.cwd, 15)) say(`${s.id.slice(0, 8)}  ${s.updated.slice(0, 16).replace('T', ' ')}  ${String(s.messages).padStart(4)} msgs  ${s.title ?? ''}`);
          return;
        }
        case 'resume':
          if (!arg) return say('usage: /resume <id prefix>');
          return this.swap(await this.rt.createAgent({ resume: arg }));
        case 'fork':
          return this.swap(await this.rt.createAgent({ fork: { session: this.agent.session.id } }));
        case 'tools':
          return say(this.agent.tools.list().map((t) => `${t.name} ${c.gray(`(${t.kind}${t.concurrent ? ', parallel' : ''})`)}`).join('\n'));
        case 'skills':
          return say(this.rt.skills.map((s) => `${s.name}: ${c.gray(s.description)}`).join('\n') || 'no skills found');
        case 'memory': {
          for (const s of this.agent.memory?.status() ?? []) say(`${s.provider}: ${s.healthy ? 'healthy' : 'unavailable'} via ${s.transport}${s.detail ? c.gray(` (${s.detail})`) : ''}`);
          const d = this.agent.memory?.systemBlock();
          return say(d ? c.dim(d) : 'no digest loaded');
        }
        case 'usage':
          return say(formatUsage(this.agent.totalUsage));
        default:
          return say(`unknown command /${cmd}; try /help`);
      }
    } catch (err) {
      this.running = false;
      say(c.red(`error: ${(err as Error).message}`));
    }
  }

  private exiting = false;

  async exit(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    process.stdout.write(c.gray('\nsaving session...\n'));
    try {
      await this.rt.close();
    } finally {
      process.stdout.write(c.gray(`session ${this.agent.session.id} (resume with: loom -r ${this.agent.session.id.slice(0, 8)})\n`));
      process.exit(0);
    }
  }
}
