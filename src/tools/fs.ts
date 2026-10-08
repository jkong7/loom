import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Tool, ToolContext } from '../agent/tool.ts';
import { textResult } from '../agent/tool.ts';

export function resolvePath(p: string, cwd: string): string {
  const expanded = p.startsWith('~/') || p === '~' ? homedir() + p.slice(1) : p;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function displayPath(p: string, cwd: string): string {
  const rel = relative(cwd, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p;
}

const locks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(path, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(path) === chained) locks.delete(path);
  }
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export function fingerprint(path: string): string {
  const st = statSync(path);
  return `${st.mtimeMs}:${st.size}`;
}

function markRead(ctx: ToolContext, path: string): void {
  try {
    ctx.services.readFiles.set(path, fingerprint(path));
  } catch {}
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read',
  kind: 'read',
  concurrent: true,
  description:
    'Read a file from the local filesystem. Returns numbered lines (cat -n style). Reads up to 2000 lines from offset (1-based) by default; pass offset and limit to page through large files. Lines longer than 2000 characters are cut. Images (png, jpg, gif, webp) are returned as images when the model accepts them.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or path relative to the working directory' },
      offset: { type: 'integer', description: 'Line number to start from (1-based)', minimum: 1 },
      limit: { type: 'integer', description: 'Number of lines to read', minimum: 1 },
    },
    required: ['path'],
  },
  target: (a, { cwd }) => ({ kind: 'read', paths: [resolvePath(a.path, cwd)] }),
  async execute(a, ctx) {
    const path = resolvePath(a.path, ctx.cwd);
    if (!existsSync(path)) return textResult(`File not found: ${path}`, true);
    const st = statSync(path);
    if (st.isDirectory()) return textResult(`${path} is a directory. Use glob or bash ls to list it.`, true);
    const mime = IMAGE_TYPES[extname(path).toLowerCase()];
    if (mime) {
      if (st.size > 5 * 1024 * 1024) return textResult(`Image too large to read (${st.size} bytes)`, true);
      markRead(ctx, path);
      return { content: [{ type: 'image', data: readFileSync(path).toString('base64'), mimeType: mime }, { type: 'text', text: `Image ${displayPath(path, ctx.cwd)} (${st.size} bytes)` }] };
    }
    const buf = readFileSync(path);
    if (looksBinary(buf)) return textResult(`${path} looks like a binary file (${st.size} bytes); not shown.`, true);
    markRead(ctx, path);
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return textResult(`(${displayPath(path, ctx.cwd)} is empty)`);
    const start = Math.max(1, a.offset ?? 1);
    const limit = a.limit ?? 2000;
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return textResult(`Offset ${start} is past the end of the file (${lines.length} lines).`, true);
    const width = String(start + slice.length - 1).length;
    const body = slice.map((l, i) => `${String(start + i).padStart(width, ' ')}\t${l.length > 2000 ? l.slice(0, 2000) + ' [line truncated]' : l}`).join('\n');
    const more = start - 1 + slice.length < lines.length ? `\n\n[showing lines ${start}-${start + slice.length - 1} of ${lines.length}; use offset to read more]` : '';
    return textResult(body + more);
  },
};

export const writeTool: Tool<{ path: string; content: string }> = {
  name: 'write',
  kind: 'edit',
  description:
    'Write a file, creating parent directories as needed. Overwrites existing files, so read an existing file first; prefer edit for changes to existing files. Use for new files and full rewrites.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path, or path relative to the working directory' },
      content: { type: 'string', description: 'Full file contents' },
    },
    required: ['path', 'content'],
  },
  target: (a, { cwd }) => ({ kind: 'edit', paths: [resolvePath(a.path, cwd)], description: `write ${a.path}` }),
  async execute(a, ctx) {
    const path = resolvePath(a.path, ctx.cwd);
    return withFileLock(path, () => {
      const existed = existsSync(path);
      if (existed) {
        if (statSync(path).isDirectory()) return textResult(`${path} is a directory`, true);
        const seen = ctx.services.readFiles.get(path);
        if (seen === undefined) return textResult(`${displayPath(path, ctx.cwd)} already exists and has not been read in this session. Read it first, then write or edit it.`, true);
        if (fingerprint(path) !== seen) return textResult(`${displayPath(path, ctx.cwd)} changed on disk since you read it. Read it again before overwriting.`, true);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, a.content);
      markRead(ctx, path);
      const lines = a.content.split('\n').length;
      return textResult(`${existed ? 'Overwrote' : 'Created'} ${displayPath(path, ctx.cwd)} (${lines} lines)`);
    });
  },
};

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function normalizeWs(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function hintFor(content: string, old: string): string {
  const firstLine = old.split('\n').find((l) => l.trim())?.trim();
  if (!firstLine) return '';
  const lines = content.split('\n');
  const hits = lines.map((l, i) => (l.includes(firstLine) ? i + 1 : 0)).filter(Boolean).slice(0, 3);
  if (hits.length) return ` The first line of old_string appears at line(s) ${hits.join(', ')}; check whitespace and the following lines, then read the file again.`;
  if (normalizeWs(content).includes(normalizeWs(old))) return ' A whitespace-insensitive match exists: copy the exact indentation from the file.';
  return ' Read the file again to get the current text.';
}

export function applyEdits(content: string, edits: EditSpec[]): { content: string; error?: string; replaced: number } {
  let out = content;
  let replaced = 0;
  for (const [i, e] of edits.entries()) {
    const label = edits.length > 1 ? `edit ${i + 1}: ` : '';
    if (e.old_string === e.new_string) return { content, replaced, error: `${label}old_string and new_string are identical` };
    if (e.old_string === '') {
      if (out !== '') return { content, replaced, error: `${label}old_string is empty but the file is not; empty old_string only creates content in an empty file` };
      out = e.new_string;
      replaced++;
      continue;
    }
    const count = out.split(e.old_string).length - 1;
    if (count === 0) return { content, replaced, error: `${label}old_string was not found.${hintFor(out, e.old_string)}` };
    if (count > 1 && !e.replace_all) return { content, replaced, error: `${label}old_string matches ${count} places. Add surrounding lines to make it unique, or set replace_all.` };
    out = e.replace_all ? out.split(e.old_string).join(e.new_string) : out.replace(e.old_string, () => e.new_string);
    replaced += e.replace_all ? count : 1;
  }
  return { content: out, replaced };
}

function snippet(content: string, needle: string, cwdPath: string): string {
  const idx = content.indexOf(needle);
  if (idx < 0 || !needle) return '';
  const startLine = content.slice(0, idx).split('\n').length;
  const lines = content.split('\n');
  const from = Math.max(1, startLine - 2);
  const to = Math.min(lines.length, startLine + needle.split('\n').length + 1);
  return `\n${cwdPath} lines ${from}-${to} now:\n` + lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
}

export const editTool: Tool<{ path: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: EditSpec[] }> = {
  name: 'edit',
  kind: 'edit',
  description:
    'Replace exact text in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is set. For several changes to one file pass edits: [{old_string, new_string, replace_all?}], applied in order and atomically. Read the file first. To create a file use write.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      edits: {
        type: 'array',
        items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] },
      },
    },
    required: ['path'],
  },
  target: (a, { cwd }) => ({ kind: 'edit', paths: [resolvePath(a.path, cwd)], description: `edit ${a.path}` }),
  async execute(a, ctx) {
    const path = resolvePath(a.path, ctx.cwd);
    const edits: EditSpec[] = a.edits?.length ? a.edits : a.old_string !== undefined && a.new_string !== undefined ? [{ old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all }] : [];
    if (!edits.length) return textResult('Provide old_string and new_string, or edits.', true);
    return withFileLock(path, () => {
      if (!existsSync(path)) return textResult(`File not found: ${path}. Use write to create it.`, true);
      const seen = ctx.services.readFiles.get(path);
      if (seen === undefined) return textResult(`Read ${displayPath(path, ctx.cwd)} before editing it.`, true);
      if (fingerprint(path) !== seen) return textResult(`${displayPath(path, ctx.cwd)} changed on disk since you read it. Read it again, then edit.`, true);
      const content = readFileSync(path, 'utf8');
      const r = applyEdits(content, edits);
      if (r.error) return textResult(`Edit failed for ${displayPath(path, ctx.cwd)}: ${r.error}`, true);
      writeFileSync(path, r.content);
      markRead(ctx, path);
      const last = edits[edits.length - 1];
      return textResult(`Edited ${displayPath(path, ctx.cwd)} (${r.replaced} replacement${r.replaced === 1 ? '' : 's'}).${snippet(r.content, last.new_string, displayPath(path, ctx.cwd))}`);
    });
  },
};
