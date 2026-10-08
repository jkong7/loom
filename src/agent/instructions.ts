import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const INSTRUCTION_FILES = ['AGENTS.md', 'LOOM.md', 'CLAUDE.md'];

export interface InstructionFile {
  path: string;
  scope: 'global' | 'project' | 'local';
  content: string;
}

export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readCapped(path: string, maxChars: number): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const text = readFileSync(path, 'utf8');
    return text.length > maxChars ? text.slice(0, maxChars) + `\n[truncated: ${path} is longer than ${maxChars} characters]` : text;
  } catch {
    return null;
  }
}

function expandImports(text: string, base: string, depth: number, seen: Set<string>, maxChars: number): string {
  if (depth > 4) return text;
  return text.replace(/^@([^\s]+)\s*$/gm, (line, ref: string) => {
    const p = resolve(base, ref.replace(/^~/, homedir()));
    if (seen.has(p)) return line;
    const body = readCapped(p, maxChars);
    if (body === null) return line;
    seen.add(p);
    return expandImports(body, dirname(p), depth + 1, seen, maxChars);
  });
}

export interface InstructionOptions {
  cwd: string;
  home?: string;
  fileNames?: string[];
  maxChars?: number;
  includeGlobal?: boolean;
}

export function loadInstructions(opts: InstructionOptions): InstructionFile[] {
  const names = opts.fileNames ?? INSTRUCTION_FILES;
  const max = opts.maxChars ?? 40000;
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const pickFirst = (dir: string, scope: InstructionFile['scope']) => {
    for (const name of names) {
      const p = join(dir, name);
      if (seen.has(p)) continue;
      const body = readCapped(p, max);
      if (body === null || !body.trim()) continue;
      seen.add(p);
      out.push({ path: p, scope, content: expandImports(body, dir, 0, seen, max) });
      return;
    }
  };
  if (opts.includeGlobal !== false && opts.home) pickFirst(opts.home, 'global');
  const cwd = resolve(opts.cwd);
  const root = findGitRoot(cwd) ?? cwd;
  const chain: string[] = [];
  let dir = cwd;
  while (true) {
    chain.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of chain.reverse()) {
    pickFirst(d, 'project');
    const local = readCapped(join(d, 'AGENTS.local.md'), max);
    if (local?.trim() && !seen.has(join(d, 'AGENTS.local.md'))) {
      seen.add(join(d, 'AGENTS.local.md'));
      out.push({ path: join(d, 'AGENTS.local.md'), scope: 'local', content: local });
    }
  }
  return out;
}

export function renderInstructions(files: InstructionFile[]): string {
  if (!files.length) return '';
  const parts = files.map((f) => `<instructions path="${f.path}" scope="${f.scope}">\n${f.content.trim()}\n</instructions>`);
  return `# Project and user instructions\n\nThese files were written by the user and their team. Follow them; more specific (deeper) files win over general ones, and the user's direct requests win over all of them.\n\n${parts.join('\n\n')}`;
}
