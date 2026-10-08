import { spawn, spawnSync } from 'node:child_process';
import { globSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Tool } from '../agent/tool.ts';
import { textResult } from '../agent/tool.ts';
import { resolvePath } from './fs.ts';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', 'coverage']);

let rgPath: string | null | undefined;

export function findRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  if (process.env.LOOM_NO_RG) return (rgPath = null);
  const r = spawnSync('/bin/sh', ['-c', 'command -v rg'], { encoding: 'utf8' });
  rgPath = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  return rgPath;
}

function run(file: string, args: string[], cwd: string, signal: AbortSignal): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      if (out.length < 4_000_000) out += d;
    });
    child.stderr.on('data', (d) => {
      if (out.length < 4_000_000) out += d;
    });
    child.on('error', () => resolve({ out, code: 2 }));
    child.on('close', (code) => resolve({ out, code: code ?? 2 }));
  });
}

function* walk(dir: string, depth = 0): Generator<string> {
  if (depth > 25) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORED.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(${glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

type GrepArgs = { pattern: string; path?: string; glob?: string; output_mode?: 'content' | 'files_with_matches' | 'count'; ignore_case?: boolean; context?: number; head_limit?: number; multiline?: boolean };

async function jsGrep(a: GrepArgs, root: string, cwd: string): Promise<string> {
  const flags = (a.ignore_case ? 'i' : '') + (a.multiline ? 'ms' : '');
  const re = new RegExp(a.pattern, flags);
  const globRe = a.glob ? globToRe(a.glob) : null;
  const mode = a.output_mode ?? 'files_with_matches';
  const out: string[] = [];
  const files = statSync(root).isFile() ? [root] : walk(root);
  for (const f of files) {
    const rel = relative(cwd, f) || f;
    if (globRe && !globRe.test(rel)) continue;
    let text: string;
    try {
      if (statSync(f).size > 2_000_000) continue;
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    if (mode === 'files_with_matches') {
      if (re.test(text)) out.push(rel);
      continue;
    }
    const lines = text.split('\n');
    let count = 0;
    lines.forEach((l, i) => {
      if (!re.test(l)) return;
      count++;
      if (mode === 'content') {
        const c = a.context ?? 0;
        for (let k = Math.max(0, i - c); k <= Math.min(lines.length - 1, i + c); k++) out.push(`${rel}:${k + 1}${k === i ? ':' : '-'}${lines[k]}`);
      }
    });
    if (mode === 'count' && count) out.push(`${rel}:${count}`);
    if (out.length > 5000) break;
  }
  return out.join('\n');
}

export const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  kind: 'read',
  concurrent: true,
  description:
    'Search file contents with a regular expression (ripgrep syntax; uses rg when installed). output_mode: files_with_matches (default), content (matching lines with line numbers) or count. Filter files with glob (for example "*.ts" or "src/**/*.py"). Respects .gitignore and skips node_modules and .git.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      ignore_case: { type: 'boolean' },
      context: { type: 'integer', description: 'Lines of context around matches (content mode)', minimum: 0 },
      head_limit: { type: 'integer', description: 'Return at most this many lines (default 250)', minimum: 1 },
      multiline: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  target: (a, { cwd }) => ({ kind: 'read', paths: [resolvePath(a.path ?? '.', cwd)] }),
  async execute(a, ctx) {
    const root = resolvePath(a.path ?? '.', ctx.cwd);
    try {
      statSync(root);
    } catch {
      return textResult(`Path not found: ${root}`, true);
    }
    try {
      new RegExp(a.pattern);
    } catch (err) {
      return textResult(`Invalid regex: ${(err as Error).message}`, true);
    }
    const mode = a.output_mode ?? 'files_with_matches';
    const limit = a.head_limit ?? 250;
    let out: string;
    const rg = findRipgrep();
    if (rg) {
      const args = ['--no-heading', '--color', 'never', '--hidden', '--glob', '!.git', '--max-columns', '500'];
      if (mode === 'files_with_matches') args.push('-l');
      else if (mode === 'count') args.push('-c');
      else args.push('-n');
      if (a.ignore_case) args.push('-i');
      if (a.multiline) args.push('-U', '--multiline-dotall');
      if (a.context && mode === 'content') args.push('-C', String(a.context));
      if (a.glob) args.push('--glob', a.glob);
      args.push('-e', a.pattern, relative(ctx.cwd, root) || '.');
      const r = await run(rg, args, ctx.cwd, ctx.signal);
      if (r.code === 2 && r.out.trim()) return textResult(`rg error: ${r.out.trim().slice(0, 1000)}`, true);
      out = r.out;
    } else out = await jsGrep(a, root, ctx.cwd);
    const lines = out.split('\n').filter(Boolean);
    if (!lines.length) return textResult('No matches.');
    const shown = lines.slice(0, limit);
    const more = lines.length > limit ? `\n[${lines.length - limit} more lines; narrow the search or raise head_limit]` : '';
    return textResult(shown.join('\n') + more);
  },
};

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  kind: 'read',
  concurrent: true,
  description: 'Find files by glob pattern (for example "**/*.ts" or "src/**/test_*.py"). Returns paths sorted by most recently modified, skipping node_modules and .git. Use it to locate files by name.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search from (default: working directory)' } }, required: ['pattern'] },
  target: (a, { cwd }) => ({ kind: 'read', paths: [resolvePath(a.path ?? '.', cwd)] }),
  async execute(a, ctx) {
    const root = resolvePath(a.path ?? '.', ctx.cwd);
    let found: string[];
    try {
      found = globSync(a.pattern, { cwd: root, exclude: (p: string) => IGNORED.has(String(p).split('/').pop()!) }) as string[];
    } catch (err) {
      return textResult(`glob failed: ${(err as Error).message}`, true);
    }
    const withTime = found
      .map((f) => {
        const abs = join(root, f);
        try {
          const st = statSync(abs);
          return st.isFile() ? { f: relative(ctx.cwd, abs) || abs, t: st.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; t: number } => !!x)
      .sort((x, y) => y.t - x.t);
    if (!withTime.length) return textResult('No files matched.');
    const limit = 200;
    const more = withTime.length > limit ? `\n[${withTime.length - limit} more; use a narrower pattern]` : '';
    return textResult(withTime.slice(0, limit).map((x) => x.f).join('\n') + more);
  },
};
