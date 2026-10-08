import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import type { Tool } from '../agent/tool.ts';
import { textResult } from '../agent/tool.ts';

export interface SandboxConfig {
  mode: 'off' | 'seatbelt' | 'bwrap' | 'auto';
  network?: boolean;
  writable?: string[];
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function seatbeltProfile(cwd: string, cfg: SandboxConfig): string {
  const dirs = [cwd, tmpdir(), '/private/tmp', '/private/var/folders', `${homedir()}/.cache`, `${homedir()}/.npm`, ...(cfg.writable ?? [])].map(real);
  const writes = [...new Set(dirs)].map((d) => `(subpath ${JSON.stringify(d)})`).join(' ');
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  ];
  if (!cfg.network) lines.push('(deny network-outbound)', '(allow network-outbound (remote unix-socket) (remote ip "localhost:*"))');
  return lines.join('\n');
}

export function bwrapArgs(command: string, cwd: string, cfg: SandboxConfig): string[] {
  const writable = [...new Set([cwd, tmpdir(), '/tmp', `${homedir()}/.cache`, ...(cfg.writable ?? [])].map(real))];
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent'];
  for (const d of writable) args.push('--bind-try', d, d);
  if (!cfg.network) args.push('--unshare-net');
  args.push('--chdir', cwd, '/bin/bash', '-c', command);
  return args;
}

let bwrapPath: string | null | undefined;

function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  for (const p of ['/usr/bin/bwrap', '/usr/local/bin/bwrap']) if (existsSync(p)) return (bwrapPath = p);
  return (bwrapPath = null);
}

export function resolveSandboxMode(cfg?: SandboxConfig): 'off' | 'seatbelt' | 'bwrap' {
  if (!cfg || cfg.mode === 'off') return 'off';
  if (cfg.mode === 'seatbelt' || (cfg.mode === 'auto' && process.platform === 'darwin')) return process.platform === 'darwin' ? 'seatbelt' : 'off';
  if (cfg.mode === 'bwrap' || (cfg.mode === 'auto' && process.platform === 'linux')) return findBwrap() ? 'bwrap' : 'off';
  return 'off';
}

export function wrapCommand(command: string, cwd: string, sandbox?: SandboxConfig): { file: string; args: string[] } {
  const mode = resolveSandboxMode(sandbox);
  if (mode === 'seatbelt') return { file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(cwd, sandbox!), '/bin/bash', '-c', command] };
  if (mode === 'bwrap') return { file: findBwrap()!, args: bwrapArgs(command, cwd, sandbox!) };
  return { file: '/bin/bash', args: ['-c', command] };
}

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  read: number;
  exit: number | null;
  started: number;
}

const jobs = new Map<string, Job>();
let jobSeq = 0;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      if (child.exitCode === null) process.kill(-child.pid!, 'SIGKILL');
    } catch {}
  }, 1500).unref();
}

export function killAllJobs(): void {
  for (const j of jobs.values()) killTree(j.child);
}

function sandboxOf(services: Record<string, unknown>): SandboxConfig | undefined {
  return services.sandbox as SandboxConfig | undefined;
}

const MAX_CAPTURE = 2_000_000;

export const bashTool: Tool<{ command: string; timeout?: number; description?: string; run_in_background?: boolean }> = {
  name: 'bash',
  kind: 'execute',
  description:
    'Run a shell command with bash in the working directory and return combined stdout and stderr plus the exit code. Default timeout 120 seconds (max 600). The working directory resets for each call; use absolute paths or cd within one command. Set run_in_background for servers and long jobs, then poll with bash_output. Prefer read, grep and glob over cat, grep and find.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'integer', description: 'Seconds before the command is killed (default 120, max 600)', minimum: 1, maximum: 600 },
      description: { type: 'string', description: 'Five to ten words on what the command does' },
      run_in_background: { type: 'boolean' },
    },
    required: ['command'],
  },
  target: (a) => ({ kind: 'execute', subject: a.command, description: a.description }),
  async execute(a, ctx) {
    const { file, args } = wrapCommand(a.command, ctx.cwd, sandboxOf(ctx.services));
    const env = { ...process.env, LOOM: '1', LOOM_SESSION_ID: ctx.sessionId, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' };
    const child = spawn(file, args, { cwd: ctx.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (a.run_in_background) {
      const id = `job${++jobSeq}`;
      const job: Job = { id, command: a.command, child, output: '', read: 0, exit: null, started: Date.now() };
      const onData = (d: Buffer) => {
        job.output += d.toString();
        if (job.output.length > MAX_CAPTURE) {
          const drop = job.output.length - MAX_CAPTURE;
          job.output = job.output.slice(drop);
          job.read = Math.max(0, job.read - drop);
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('close', (code) => (job.exit = code ?? -1));
      jobs.set(id, job);
      return textResult(`Started background job ${id} (pid ${child.pid}). Use bash_output with id "${id}" to read its output and bash_kill to stop it.`);
    }
    const timeoutMs = Math.min(a.timeout ?? 120, 600) * 1000;
    return new Promise((resolve) => {
      let out = '';
      let timedOut = false;
      const onData = (d: Buffer) => {
        out += d.toString();
        ctx.onUpdate?.(d.toString());
        if (out.length > MAX_CAPTURE) out = out.slice(-MAX_CAPTURE);
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      const onAbort = () => killTree(child);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(textResult(`Failed to start command: ${err.message}`, true));
      });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const body = out.trimEnd() || '(no output)';
        if (timedOut) return resolve(textResult(`${body}\n\n[killed after ${timeoutMs / 1000}s timeout; use run_in_background for long jobs]`, true));
        if (ctx.signal.aborted) return resolve(textResult(`${body}\n\n[interrupted]`, true));
        const status = code === 0 ? '' : `\n\n[exit code ${code ?? sig}]`;
        resolve(textResult(body + status, code !== 0, { exitCode: code }));
      });
    });
  },
};

export const bashOutputTool: Tool<{ id: string }> = {
  name: 'bash_output',
  kind: 'read',
  concurrent: true,
  description: 'Read new output from a background job started with bash run_in_background, and whether it is still running.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async execute(a) {
    const job = jobs.get(a.id);
    if (!job) return textResult(`No background job "${a.id}". Known jobs: ${[...jobs.keys()].join(', ') || 'none'}`, true);
    const fresh = job.output.slice(job.read);
    job.read = job.output.length;
    const state = job.exit === null ? `running for ${Math.round((Date.now() - job.started) / 1000)}s` : `exited with code ${job.exit}`;
    return textResult(`[${job.id}: ${state}]\n${fresh || '(no new output)'}`);
  },
};

export const bashKillTool: Tool<{ id: string }> = {
  name: 'bash_kill',
  kind: 'execute',
  description: 'Stop a background job started with bash run_in_background.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  target: (a) => ({ kind: 'execute', subject: `kill ${a.id}` }),
  async execute(a) {
    const job = jobs.get(a.id);
    if (!job) return textResult(`No background job "${a.id}"`, true);
    killTree(job.child);
    return textResult(`Stopped ${a.id}`);
  },
};
