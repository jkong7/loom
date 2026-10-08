import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, ToolResultMessage } from '../ai/types.ts';
import { textOf } from '../ai/types.ts';
import { stripThinking } from '../ai/transform.ts';

export const SESSION_VERSION = 1;

interface Base {
  id: string;
  parentId: string | null;
  ts: string;
  session_id: string;
}

export interface SessionHeader {
  type: 'session';
  v: number;
  id: string;
  session_id: string;
  ts: string;
  cwd: string;
  harness: string;
  model?: string;
  parent_session?: string;
  forked_from?: { session_id: string; entry_id: string; path: string };
  title?: string;
  agent?: string;
}

export interface MessageEntry extends Base {
  type: 'message';
  role: Message['role'];
  text: string;
  cwd: string;
  message: Message;
}

export interface CompactionEntry extends Base {
  type: 'compaction';
  summary: string;
  firstKeptId: string | null;
  tokensBefore: number;
  tokensAfter?: number;
  reason: 'threshold' | 'overflow' | 'manual';
}

export interface PruneEntry extends Base {
  type: 'prune';
  toolCallIds: string[];
  tokensSaved: number;
}

export interface ModelChangeEntry extends Base {
  type: 'model_change';
  model: string;
}

export interface LabelEntry extends Base {
  type: 'label';
  label: string;
}

export interface CustomEntry extends Base {
  type: 'custom';
  kind: string;
  data: unknown;
}

export type Entry = MessageEntry | CompactionEntry | PruneEntry | ModelChangeEntry | LabelEntry | CustomEntry;
type Line = SessionHeader | Entry;

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+/, '').slice(-120) || 'root';
}

function nowIso(): string {
  return new Date().toISOString();
}

function newSessionId(): string {
  return randomUUID();
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title?: string;
  started: string;
  updated: string;
  messages: number;
  model?: string;
  parent_session?: string;
}

export const PRUNED_MARKER = '[tool output pruned from context to save space; rerun the tool if you still need it]';

export class Session {
  readonly path: string;
  header: SessionHeader;
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();
  leafId: string | null = null;
  private persist: boolean;

  private constructor(path: string, header: SessionHeader, persist: boolean) {
    this.path = path;
    this.header = header;
    this.persist = persist;
  }

  get id(): string {
    return this.header.session_id;
  }

  get cwd(): string {
    return this.header.cwd;
  }

  get dir(): string {
    return join(dirname(this.path), basename(this.path, '.jsonl'));
  }

  static create(opts: { root: string; cwd: string; model?: string; harness?: string; parentSession?: string; agent?: string; id?: string; persist?: boolean }): Session {
    const id = opts.id ?? newSessionId();
    const ts = nowIso();
    const dir = join(opts.root, encodeCwd(opts.cwd));
    const path = join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`);
    const header: SessionHeader = { type: 'session', v: SESSION_VERSION, id, session_id: id, ts, cwd: opts.cwd, harness: opts.harness ?? 'loom', model: opts.model, parent_session: opts.parentSession, agent: opts.agent };
    const s = new Session(path, header, opts.persist !== false);
    if (s.persist) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(header) + '\n');
    }
    return s;
  }

  static memory(cwd: string, model?: string): Session {
    return Session.create({ root: '/nonexistent', cwd, model, persist: false });
  }

  static open(path: string): Session {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    let header: SessionHeader | undefined;
    const entries: Entry[] = [];
    for (const l of lines) {
      let d: Line;
      try {
        d = JSON.parse(l);
      } catch {
        continue;
      }
      if (d.type === 'session') header ??= d;
      else entries.push(d);
    }
    if (!header) throw new Error(`not a loom session file: ${path}`);
    const s = new Session(path, header, true);
    for (const e of entries) {
      s.entries.push(e);
      s.byId.set(e.id, e);
      if (e.type === 'custom' && e.kind === 'title' && typeof e.data === 'string') s.header.title = e.data;
    }
    s.leafId = entries.length ? entries[entries.length - 1].id : null;
    const branch = [...entries].reverse().find((e) => e.type === 'custom' && e.kind === 'branch') as CustomEntry | undefined;
    if (branch && branch === entries[entries.length - 1]) s.leafId = (branch.data as { leafId: string | null }).leafId;
    return s;
  }

  private write(line: Line): void {
    if (this.persist) appendFileSync(this.path, JSON.stringify(line) + '\n');
  }

  private add<E extends Entry>(e: Omit<E, 'id' | 'parentId' | 'ts' | 'session_id'>): E {
    const entry = { id: randomUUID().slice(0, 12), parentId: this.leafId, ts: nowIso(), session_id: this.id, ...e } as E;
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.write(entry);
    return entry;
  }

  appendMessage(message: Message): MessageEntry {
    let text: string;
    if (message.role === 'tool') text = textOf(message.content).slice(0, 4000);
    else text = textOf(message.content);
    if (!this.header.title && message.role === 'user' && text) {
      this.header.title = text.replace(/\s+/g, ' ').slice(0, 80);
      this.add<CustomEntry>({ type: 'custom', kind: 'title', data: this.header.title });
    }
    return this.add<MessageEntry>({ type: 'message', role: message.role, text, cwd: this.cwd, message });
  }

  appendCompaction(c: Omit<CompactionEntry, 'id' | 'parentId' | 'ts' | 'session_id' | 'type'>): CompactionEntry {
    return this.add<CompactionEntry>({ type: 'compaction', ...c });
  }

  appendPrune(toolCallIds: string[], tokensSaved: number): PruneEntry {
    return this.add<PruneEntry>({ type: 'prune', toolCallIds, tokensSaved });
  }

  appendModelChange(model: string): void {
    this.add<ModelChangeEntry>({ type: 'model_change', model });
  }

  appendCustom(kind: string, data: unknown): CustomEntry {
    return this.add<CustomEntry>({ type: 'custom', kind, data });
  }

  label(label: string): void {
    this.add<LabelEntry>({ type: 'label', label });
  }

  get(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  allEntries(): Entry[] {
    return [...this.entries];
  }

  branch(): Entry[] {
    const out: Entry[] = [];
    let cur = this.leafId ? this.byId.get(this.leafId) : undefined;
    while (cur) {
      out.push(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return out.reverse();
  }

  rewindTo(entryId: string | null): void {
    if (entryId && !this.byId.has(entryId)) throw new Error(`no entry ${entryId}`);
    this.leafId = entryId;
    this.write({ type: 'custom', kind: 'branch', id: randomUUID().slice(0, 12), parentId: entryId, ts: nowIso(), session_id: this.id, data: { leafId: entryId } } as CustomEntry);
  }

  messages(): Message[] {
    return this.branch()
      .filter((e): e is MessageEntry => e.type === 'message')
      .map((e) => e.message);
  }

  lastModel(): string | undefined {
    const b = this.branch();
    for (let i = b.length - 1; i >= 0; i--) {
      const e = b[i];
      if (e.type === 'model_change') return e.model;
    }
    return this.header.model;
  }

  latestCompaction(): CompactionEntry | undefined {
    const b = this.branch();
    for (let i = b.length - 1; i >= 0; i--) if (b[i].type === 'compaction') return b[i] as CompactionEntry;
    return undefined;
  }

  contextMessages(): Message[] {
    const b = this.branch();
    let start = 0;
    let summary: CompactionEntry | undefined;
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].type === 'compaction') {
        summary = b[i] as CompactionEntry;
        start = i + 1;
        break;
      }
    }
    const out: Message[] = [];
    if (summary) {
      out.push({ role: 'user', content: [{ type: 'text', text: summaryMessage(summary.summary), meta: 'summary' }], ts: Date.parse(summary.ts) });
      if (summary.firstKeptId) {
        const idx = b.findIndex((e) => e.id === summary!.firstKeptId);
        const kept = b.slice(idx >= 0 ? idx : start, b.indexOf(summary)).filter((e): e is MessageEntry => e.type === 'message').map((e) => e.message);
        out.push(...stripThinking(kept));
      }
    }
    const pruned = new Set<string>();
    let pruneCut = -1;
    const tail = b.slice(start);
    tail.forEach((e, i) => {
      if (e.type === 'prune') {
        for (const id of e.toolCallIds) pruned.add(id);
        pruneCut = i;
      }
    });
    if (pruned.size) {
      for (const m of out) if (m.role === 'tool' && pruned.has(m.toolCallId)) Object.assign(m, prunedResult(m));
    }
    tail.forEach((e, i) => {
      if (e.type !== 'message') return;
      let m = e.message;
      if (i < pruneCut) {
        if (m.role === 'tool' && pruned.has(m.toolCallId)) m = prunedResult(m);
        if (m.role === 'assistant') m = { ...m, content: m.content.filter((c) => c.type !== 'thinking') };
      }
      out.push(m);
    });
    return out;
  }

  fork(root: string, atEntryId?: string): Session {
    const target = atEntryId ?? this.leafId;
    const chain: Entry[] = [];
    let cur = target ? this.byId.get(target) : undefined;
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    chain.reverse();
    const s = Session.create({ root, cwd: this.cwd, model: this.lastModel(), harness: this.header.harness, persist: this.persist });
    s.header.forked_from = { session_id: this.id, entry_id: target ?? '', path: this.path };
    s.header.title = this.header.title ? `${this.header.title} (fork)` : undefined;
    if (s.persist) writeFileSync(s.path, JSON.stringify(s.header) + '\n');
    for (const e of chain) {
      const copy = { ...e, session_id: s.id } as Entry;
      if (copy.type === 'message') copy.message = structuredClone(copy.message);
      s.entries.push(copy);
      s.byId.set(copy.id, copy);
      s.leafId = copy.id;
      s.write(copy);
    }
    return s;
  }

  summary(): SessionSummary {
    const msgs = this.entries.filter((e) => e.type === 'message');
    return {
      id: this.id,
      path: this.path,
      cwd: this.cwd,
      title: this.header.title,
      started: this.header.ts,
      updated: this.entries.length ? this.entries[this.entries.length - 1].ts : this.header.ts,
      messages: msgs.length,
      model: this.lastModel(),
      parent_session: this.header.parent_session,
    };
  }
}

function prunedResult(m: ToolResultMessage): ToolResultMessage {
  return { ...m, content: [{ type: 'text', text: PRUNED_MARKER }] };
}

export function summaryMessage(summary: string): string {
  return `<conversation-summary>\nThe earlier part of this conversation was compacted to save context. This summary replaces it; continue from where it leaves off.\n\n${summary}\n</conversation-summary>`;
}

export class SessionStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  create(opts: { cwd: string; model?: string; parentSession?: string; agent?: string }): Session {
    return Session.create({ root: this.root, ...opts });
  }

  open(path: string): Session {
    return Session.open(path);
  }

  files(cwd?: string): string[] {
    const dirs = cwd ? [join(this.root, encodeCwd(cwd))] : existsSync(this.root) ? readdirSync(this.root).map((d) => join(this.root, d)) : [];
    const out: string[] = [];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (f.endsWith('.jsonl')) out.push(join(d, f));
    }
    return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  }

  list(cwd?: string, limit = 20): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const f of this.files(cwd)) {
      try {
        const s = Session.open(f);
        if (s.header.parent_session) continue;
        out.push(s.summary());
      } catch {}
      if (out.length >= limit) break;
    }
    return out;
  }

  find(idOrPrefix: string): Session | undefined {
    if (existsSync(idOrPrefix) && idOrPrefix.endsWith('.jsonl')) return Session.open(idOrPrefix);
    for (const f of this.files()) if (basename(f).includes(`_${idOrPrefix}`)) return Session.open(f);
    return undefined;
  }

  latest(cwd: string): Session | undefined {
    for (const f of this.files(cwd)) {
      try {
        const s = Session.open(f);
        if (!s.header.parent_session) return s;
      } catch {}
    }
    return undefined;
  }
}
