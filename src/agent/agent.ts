import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage, Context, Message, Model, ReasoningLevel, StreamEvent, StreamOptions, SystemBlock, ToolCallPart, ToolResultMessage, ToolSpec, Usage, UserContent, UserMessage } from '../ai/types.ts';
import { emptyUsage, textOf, toolCalls } from '../ai/types.ts';
import { stream, type ModelRegistry } from '../ai/registry.ts';
import { contextTokens, estimateContextTokens, estimateTextTokens } from '../ai/tokens.ts';
import { validate, coerce } from './schema.ts';
import { normalizeResult, textResult, type Tool, type ToolContext, type ToolRegistry, type ToolResult, type ToolServices } from './tool.ts';
import type { PermissionPolicy } from './permissions.ts';
import { HookBus, type HookEvent, type HookInput, type HookResult } from './hooks.ts';
import type { Session } from './session.ts';
import { buildSystemPrompt, type PromptParts } from './prompt.ts';
import { DEFAULT_COMPACTION, compactionThreshold, fallbackSummary, findCutIndex, isContextOverflow, planPrune, shouldCompact, summarize, summaryTokens, type CompactionSettings } from './compaction.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { AgentContextKind, MemorySessionInfo } from '../memory/provider.ts';
import { findGitRoot } from './instructions.ts';
import type { Snapshots } from './snapshots.ts';

export type AgentEvent =
  | { type: 'agent_start'; sessionId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'message_start'; message: AssistantMessage }
  | { type: 'message_update'; event: StreamEvent }
  | { type: 'message_end'; message: Message }
  | { type: 'tool_start'; call: ToolCallPart }
  | { type: 'tool_update'; callId: string; text: string }
  | { type: 'tool_end'; call: ToolCallPart; result: ToolResultMessage; durationMs: number }
  | { type: 'permission'; tool: string; decision: 'allow' | 'deny'; reason: string }
  | { type: 'compaction'; phase: 'start' | 'end' | 'prune'; reason: string; tokensBefore: number; tokensAfter?: number; summary?: string }
  | { type: 'memory'; kind: 'digest' | 'recall'; text: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'agent_end'; reason: EndReason; message?: AssistantMessage; usage: Usage; turns: number };

export type EndReason = 'done' | 'aborted' | 'error' | 'max_turns' | 'blocked' | 'refusal';

export interface RunResult {
  reason: EndReason;
  text: string;
  message?: AssistantMessage;
  usage: Usage;
  turns: number;
  error?: string;
}

export interface AgentOptions {
  model: Model;
  registry: ModelRegistry;
  session: Session;
  tools: ToolRegistry;
  permissions: PermissionPolicy;
  hooks?: HookBus;
  memory?: MemoryManager;
  prompt?: Omit<PromptParts, 'cwd' | 'memory' | 'model'>;
  reasoning?: ReasoningLevel;
  maxTokens?: number;
  temperature?: number;
  compaction?: Partial<CompactionSettings>;
  compactionModel?: Model;
  maxTurns?: number;
  toolOutputMaxChars?: number;
  maxParallelTools?: number;
  depth?: number;
  agentContext?: AgentContextKind;
  harness?: string;
  streamOptions?: Omit<StreamOptions, 'signal'>;
  services?: Record<string, unknown>;
  stopHookLimit?: number;
  snapshots?: Snapshots;
}

type Listener = (e: AgentEvent) => void;

function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: (a.cost ?? 0) + (b.cost ?? 0) };
}

function reminder(text: string): string {
  return `<system-reminder>\n${text.trim()}\n</system-reminder>`;
}

export class Agent {
  model: Model;
  readonly registry: ModelRegistry;
  session: Session;
  readonly tools: ToolRegistry;
  readonly permissions: PermissionPolicy;
  readonly hooks: HookBus;
  readonly memory?: MemoryManager;
  readonly opts: AgentOptions;
  readonly compaction: CompactionSettings;
  private listeners = new Set<Listener>();
  private system: SystemBlock[] = [];
  private toolSpecs: ToolSpec[] = [];
  private systemTokens = 0;
  private started = false;
  private running: Promise<RunResult> | null = null;
  private abortCtl: AbortController | null = null;
  private steering: UserContent[][] = [];
  private followUps: string[] = [];
  readonly services: ToolServices;
  totalUsage: Usage = emptyUsage();

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.registry = opts.registry;
    this.session = opts.session;
    this.tools = opts.tools.filter(() => true);
    this.permissions = opts.permissions;
    this.hooks = opts.hooks ?? new HookBus();
    this.memory = opts.memory;
    this.compaction = { ...DEFAULT_COMPACTION, ...opts.compaction };
    this.services = { readFiles: new Map(), outputDir: join(this.session.dir, 'tool-outputs'), agent: this, ...opts.services };
  }

  get cwd(): string {
    return this.session.cwd;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(level: 'info' | 'warn' | 'error', text: string): void {
    this.emit({ type: 'notice', level, text });
  }

  private emit(e: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {}
    }
  }

  hookInput(event: HookEvent, extra: Record<string, unknown> = {}): HookInput {
    return { hook_event_name: event, session_id: this.session.id, transcript_path: this.session.path, cwd: this.cwd, harness: this.opts.harness ?? 'loom', model: `${this.model.provider}/${this.model.id}`, agent_depth: this.opts.depth ?? 0, ...extra };
  }

  memoryInfo(source: MemorySessionInfo['source']): MemorySessionInfo {
    return {
      sessionId: this.session.id,
      cwd: this.cwd,
      transcriptPath: this.session.path,
      harness: this.opts.harness ?? 'loom',
      model: `${this.model.provider}/${this.model.id}`,
      agentContext: this.opts.agentContext ?? 'primary',
      parentSessionId: this.session.header.parent_session_id,
      source,
    };
  }

  async start(source: MemorySessionInfo['source'] = this.session.messages().length ? 'resume' : 'startup'): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.memory) {
      await this.memory.initialize(this.memoryInfo(source));
      for (const t of this.memory.tools()) this.tools.register(t);
    }
    const hook = await this.hooks.emit(this.hookInput('SessionStart', { source }));
    this.freezeContext(hook.additionalContext);
    this.emit({ type: 'agent_start', sessionId: this.session.id });
  }

  private sessionContext: string[] = [];

  freezeContext(extra: string[] = this.sessionContext): void {
    this.sessionContext = extra;
    const memory = this.memory?.systemBlock() ?? null;
    if (memory) this.emit({ type: 'memory', kind: 'digest', text: memory });
    const p = this.opts.prompt ?? {};
    this.system = buildSystemPrompt({
      ...p,
      cwd: this.cwd,
      gitRoot: p.gitRoot ?? findGitRoot(this.cwd),
      model: `${this.model.provider}/${this.model.id}`,
      memory: [memory, ...extra.map((x) => `<session-context>\n${x.trim()}\n</session-context>`)].filter(Boolean).join('\n\n') || null,
    });
    this.toolSpecs = this.tools.specs();
    this.systemTokens = estimateContextTokens({ system: this.system, messages: [], tools: this.toolSpecs });
  }

  systemPrompt(): SystemBlock[] {
    return this.system;
  }

  context(): Context {
    return { system: this.system, messages: this.session.contextMessages(), tools: this.toolSpecs.length ? this.toolSpecs : undefined };
  }

  contextTokens(): number {
    return contextTokens(this.session.contextMessages(), this.systemTokens, this.session.usageBoundary());
  }

  setModel(model: Model): void {
    this.model = model;
    this.session.appendModelChange(`${model.provider}/${model.id}`);
    if (this.started) this.freezeContext();
  }

  steer(text: string): void {
    this.steering.push([{ type: 'text', text }]);
  }

  followUp(text: string): void {
    this.followUps.push(text);
  }

  abort(): void {
    this.abortCtl?.abort(new Error('aborted'));
  }

  async prompt(input: string | UserContent[], opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
    if (this.running) throw new Error('agent is already running; use steer() or followUp()');
    const p = this.run(input, opts.signal).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    this.running = p;
    let result = await p;
    while (this.followUps.length && result.reason === 'done') {
      const next = this.followUps.shift()!;
      this.running = this.run(next).finally(() => {
        this.running = null;
        this.abortCtl = null;
      });
      result = await this.running;
    }
    return result;
  }

  private append(m: Message): void {
    this.session.appendMessage(m);
    this.emit({ type: 'message_end', message: m });
  }

  private async run(input: string | UserContent[], external?: AbortSignal): Promise<RunResult> {
    await this.start();
    this.abortCtl = new AbortController();
    const signal = external ? AbortSignal.any([external, this.abortCtl.signal]) : this.abortCtl.signal;
    const content: UserContent[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    const promptText = textOf(content);
    let usage = emptyUsage();
    let turns = 0;

    const hook = await this.hooks.emit(this.hookInput('UserPromptSubmit', { prompt: promptText }), signal);
    if (hook.block) {
      this.emit({ type: 'notice', level: 'warn', text: `prompt blocked by hook: ${hook.reason ?? ''}` });
      return this.finish({ reason: 'blocked', text: '', usage, turns, error: hook.reason });
    }
    const prefix: UserContent[] = [];
    if (this.memory?.enabled) {
      const recall = await this.memory.prefetch(promptText, this.session.id, signal);
      if (recall) {
        prefix.push({ type: 'text', text: recall, meta: 'memory' });
        this.emit({ type: 'memory', kind: 'recall', text: recall });
      }
    }
    for (const ctx of hook.additionalContext) {
      if (/^\s*<memory-context[\s>]/.test(ctx)) prefix.push({ type: 'text', text: ctx, meta: 'memory' });
      else prefix.push({ type: 'text', text: reminder(ctx), meta: 'context' });
    }
    if (this.opts.snapshots && !this.opts.depth) {
      const tree = this.opts.snapshots.take();
      if (tree) this.session.appendCustom('snapshot', { tree });
    }
    const userMsg: UserMessage = { role: 'user', content: [...prefix, ...content], ts: Date.now() };
    this.append(userMsg);

    let last: AssistantMessage | undefined;
    let overflowRetried = false;
    let stopContinuations = 0;
    const maxTurns = this.opts.maxTurns ?? 200;
    const recentCalls: string[] = [];

    while (true) {
      if (signal.aborted) return this.finish({ reason: 'aborted', text: last ? textOf(last.content) : '', message: last, usage, turns });
      if (turns >= maxTurns) {
        this.emit({ type: 'notice', level: 'warn', text: `stopped after ${maxTurns} turns` });
        return this.finish({ reason: 'max_turns', text: last ? textOf(last.content) : '', message: last, usage, turns });
      }
      turns++;
      this.emit({ type: 'turn_start', turn: turns });
      await this.maybeCompact(signal, turns === 1);

      const assistant = await this.callModel(signal);
      usage = addUsage(usage, assistant.usage);
      this.totalUsage = addUsage(this.totalUsage, assistant.usage);
      last = assistant;

      if (assistant.stopReason === 'aborted') {
        if (assistant.content.length) this.append(assistant);
        return this.finish({ reason: 'aborted', text: textOf(assistant.content), message: assistant, usage, turns });
      }
      if (assistant.stopReason === 'error') {
        if (isContextOverflow(assistant.error) && !overflowRetried) {
          overflowRetried = true;
          this.emit({ type: 'notice', level: 'warn', text: 'context overflow reported by the provider; compacting and retrying' });
          await this.compact({ reason: 'overflow', signal });
          turns--;
          continue;
        }
        this.append(assistant);
        this.emit({ type: 'notice', level: 'error', text: assistant.error ?? 'model error' });
        return this.finish({ reason: 'error', text: textOf(assistant.content), message: assistant, usage, turns, error: assistant.error });
      }
      this.append(assistant);
      if (assistant.stopReason === 'refusal') return this.finish({ reason: 'refusal', text: textOf(assistant.content), message: assistant, usage, turns });

      const calls = toolCalls(assistant);
      if (calls.length) {
        if (assistant.stopReason === 'length') {
          for (const c of calls) this.append(this.toolMessage(c, textResult('Not executed: your response hit the output token limit, so this tool call may be truncated. Retry with a smaller call (for example, write the file in parts).', true)));
          continue;
        }
        await this.executeTools(calls, signal, recentCalls);
        const steer = this.steering.splice(0);
        for (const s of steer) this.append({ role: 'user', content: s, ts: Date.now() });
        continue;
      }

      const steer = this.steering.splice(0);
      if (steer.length) {
        for (const s of steer) this.append({ role: 'user', content: s, ts: Date.now() });
        continue;
      }

      const stop = await this.hooks.emit(this.hookInput(this.opts.depth ? 'SubagentStop' : 'Stop', { last_assistant_message: textOf(assistant.content), stop_hook_active: stopContinuations > 0 }), signal);
      if (stop.block && !stop.stop && stopContinuations < (this.opts.stopHookLimit ?? 3)) {
        stopContinuations++;
        this.append({ role: 'user', content: [{ type: 'text', text: reminder(`A stop hook asked you to continue: ${stop.reason ?? 'keep going'}`), meta: 'context' }], ts: Date.now() });
        continue;
      }
      if (this.memory?.enabled && !this.opts.depth) {
        this.memory.syncTurn({ user: promptText, assistant: textOf(assistant.content), sessionId: this.session.id, messages: this.session.contextMessages(), ts: new Date().toISOString() });
      }
      return this.finish({ reason: 'done', text: textOf(assistant.content), message: assistant, usage, turns });
    }
  }

  private finish(r: RunResult): RunResult {
    if (r.reason !== 'done') {
      const dropped = this.steering.length + this.followUps.length;
      this.steering = [];
      this.followUps = [];
      if (dropped) this.emit({ type: 'notice', level: 'warn', text: `dropped ${dropped} queued message(s) because the run ended with ${r.reason}` });
    }
    this.emit({ type: 'agent_end', reason: r.reason, message: r.message, usage: r.usage, turns: r.turns });
    return r;
  }

  private async callModel(signal: AbortSignal): Promise<AssistantMessage> {
    const ctx = this.context();
    let final: AssistantMessage | undefined;
    const options: StreamOptions = {
      ...this.opts.streamOptions,
      signal,
      reasoning: this.opts.reasoning,
      maxTokens: this.opts.maxTokens ?? Math.min(this.model.maxOutput, 32000),
      temperature: this.opts.temperature,
      sessionId: this.session.id,
    };
    for await (const ev of stream(this.model, ctx, options, this.registry)) {
      if (ev.type === 'start') this.emit({ type: 'message_start', message: ev.partial });
      else if (ev.type === 'done' || ev.type === 'error') final = ev.message;
      else this.emit({ type: 'message_update', event: ev });
    }
    return final ?? { role: 'assistant', content: [], provider: this.model.provider, model: this.model.id, api: this.model.api, usage: emptyUsage(), stopReason: 'error', error: 'empty stream', ts: Date.now() };
  }

  private toolMessage(call: ToolCallPart, r: ToolResult): ToolResultMessage {
    return { role: 'tool', toolCallId: call.id, toolName: call.name, content: r.content.length ? r.content : [{ type: 'text', text: r.isError ? 'error' : '(no output)' }], isError: !!r.isError, ts: Date.now() };
  }

  private truncate(call: ToolCallPart, r: ToolResult): ToolResult {
    const max = this.opts.toolOutputMaxChars ?? 30000;
    const content = r.content.map((c) => {
      if (c.type !== 'text' || c.text.length <= max) return c;
      let saved = '';
      try {
        const dir = this.services.outputDir!;
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${call.id.replace(/[^\w-]/g, '_')}.txt`);
        writeFileSync(file, c.text);
        saved = ` The full output (${c.text.length} characters) was saved to ${file}; use read with offset/limit or grep on it if you need more.`;
      } catch {}
      const head = Math.floor(max * 0.6);
      const tail = max - head;
      return { ...c, text: `${c.text.slice(0, head)}\n\n[... ${c.text.length - max} characters truncated.${saved} ...]\n\n${c.text.slice(-tail)}` };
    });
    return { ...r, content };
  }

  private async executeTools(calls: ToolCallPart[], signal: AbortSignal, recent: string[]): Promise<void> {
    const results = new Map<string, ToolResultMessage>();
    const batches: ToolCallPart[][] = [];
    for (const c of calls) {
      const tool = this.tools.get(c.name);
      const parallel = !!tool?.concurrent;
      const lastBatch = batches[batches.length - 1];
      if (parallel && lastBatch && lastBatch.every((x) => this.tools.get(x.name)?.concurrent)) lastBatch.push(c);
      else batches.push([c]);
    }
    const limit = this.opts.maxParallelTools ?? 10;
    for (const batch of batches) {
      for (let i = 0; i < batch.length; i += limit) {
        const slice = batch.slice(i, i + limit);
        const out = await Promise.all(slice.map((c) => this.runTool(c, signal, recent)));
        slice.forEach((c, j) => results.set(c.id, out[j]));
      }
      if (signal.aborted) break;
    }
    for (const c of calls) {
      const r = results.get(c.id) ?? this.toolMessage(c, textResult('Not executed: the run was aborted.', true));
      this.append(r);
    }
  }

  private async runTool(call: ToolCallPart, signal: AbortSignal, recent: string[]): Promise<ToolResultMessage> {
    const started = Date.now();
    this.emit({ type: 'tool_start', call });
    const done = (r: ToolResult) => {
      const msg = this.toolMessage(call, this.truncate(call, r));
      this.emit({ type: 'tool_end', call, result: msg, durationMs: Date.now() - started });
      return msg;
    };
    const tool = this.tools.get(call.name);
    if (!tool) return done(textResult(`Unknown tool "${call.name}". Available tools: ${this.tools.names().join(', ')}`, true));
    if ('__invalid_json' in call.args) return done(textResult(`Your arguments for ${call.name} were not valid JSON (${String(call.args.__error)}). Send a JSON object matching the schema.`, true));
    let args = coerce(tool.parameters, call.args) as Record<string, unknown>;
    const errors = validate(tool.parameters, args);
    if (errors.length) return done(textResult(`Invalid arguments for ${call.name}:\n- ${errors.join('\n- ')}`, true));

    const pre = await this.hooks.emit(this.hookInput('PreToolUse', { tool_name: call.name, tool_input: args, tool_use_id: call.id }), signal);
    if (pre.updatedInput) args = { ...args, ...pre.updatedInput };
    if (pre.block && pre.decision !== 'allow') return done(textResult(`Blocked by hook: ${pre.reason ?? 'no reason given'}`, true));
    const perm = await this.permissions.check(tool, args, this.cwd, pre.decision);
    this.emit({ type: 'permission', tool: call.name, decision: perm.decision, reason: perm.reason });
    if (perm.decision === 'deny') return done(textResult(`Permission denied: ${perm.reason}. Do not retry the same call; adjust your approach or ask the user.`, true));

    const key = `${call.name}:${JSON.stringify(args)}`;
    recent.push(key);
    if (recent.length > 6) recent.shift();
    const repeats = recent.filter((k) => k === key).length;

    let result: ToolResult;
    const ctx: ToolContext = {
      cwd: this.cwd,
      sessionId: this.session.id,
      signal,
      toolCallId: call.id,
      depth: this.opts.depth ?? 0,
      services: this.services,
      onUpdate: (text) => this.emit({ type: 'tool_update', callId: call.id, text }),
    };
    try {
      result = normalizeResult(await tool.execute(args, ctx));
    } catch (err) {
      result = textResult(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (repeats >= 3) result.content.push({ type: 'text', text: `\n[loom: you have made this exact ${call.name} call ${repeats} times recently. The result will not change; try a different approach.]` });
    const post = await this.hooks.emit(this.hookInput('PostToolUse', { tool_name: call.name, tool_input: args, tool_use_id: call.id, tool_response: textOf(result.content), is_error: !!result.isError }), signal);
    for (const c of post.additionalContext) result.content.push({ type: 'text', text: reminder(c) });
    if (post.block) result.content.push({ type: 'text', text: reminder(`PostToolUse hook: ${post.reason ?? ''}`) });
    return done(result);
  }

  private async maybeCompact(signal: AbortSignal, atRunStart: boolean): Promise<void> {
    const tokens = this.contextTokens();
    if (!shouldCompact(tokens, this.model, this.compaction)) return;
    const threshold = compactionThreshold(this.model, this.compaction);
    const prune = atRunStart ? planPrune(this.session.contextMessages(), this.compaction) : { ids: [], saved: 0 };
    if (prune.ids.length && prune.saved >= this.compaction.pruneMinSavings && tokens - prune.saved < threshold * 0.8) {
      this.session.appendPrune(prune.ids, prune.saved);
      this.emit({ type: 'compaction', phase: 'prune', reason: 'threshold', tokensBefore: tokens, tokensAfter: tokens - prune.saved });
      return;
    }
    await this.compact({ reason: 'threshold', signal });
  }

  async compact(opts: { reason?: 'threshold' | 'overflow' | 'manual'; instructions?: string; signal?: AbortSignal } = {}): Promise<{ summary: string; tokensBefore: number; tokensAfter: number }> {
    await this.start();
    const reason = opts.reason ?? 'manual';
    const messages = this.session.contextMessages();
    const tokensBefore = contextTokens(messages, this.systemTokens);
    this.emit({ type: 'compaction', phase: 'start', reason, tokensBefore });
    await this.hooks.emit(this.hookInput('PreCompact', { trigger: reason === 'manual' ? 'manual' : 'auto', custom_instructions: opts.instructions ?? null }), opts.signal);
    const notes = this.memory?.enabled ? await this.memory.onPreCompress({ messages, trigger: reason === 'manual' ? 'manual' : reason === 'overflow' ? 'overflow' : 'auto', tokensBefore }) : [];

    const branch = this.session.branch();
    const prev = this.session.latestCompaction();
    let start = 0;
    if (prev) {
      const prevIdx = branch.indexOf(prev);
      const keptIdx = prev.firstKeptId ? branch.findIndex((e) => e.id === prev.firstKeptId) : -1;
      start = keptIdx >= 0 && keptIdx < prevIdx ? keptIdx : prevIdx + 1;
    }
    const live = branch.slice(start).filter((e) => e.type === 'message') as { id: string; message: Message }[];
    const liveMessages = live.map((e) => e.message);
    const keep = reason === 'overflow' ? Math.floor(this.compaction.keepRecentTokens / 2) : this.compaction.keepRecentTokens;
    let cut = findCutIndex(liveMessages, Math.min(keep, Math.floor(this.model.contextWindow * 0.25)));
    if (cut === 0) cut = liveMessages.length;
    const toSummarize = liveMessages.slice(0, cut);
    const firstKept = cut < live.length ? live[cut].id : null;

    let summary: string;
    try {
      summary = await summarize(this.opts.compactionModel ?? this.model, toSummarize, {
        previous: prev?.summary,
        memoryNotes: notes,
        customInstructions: opts.instructions,
        settings: this.compaction,
        registry: this.registry,
        streamOptions: { ...this.opts.streamOptions, signal: opts.signal },
      });
    } catch (err) {
      this.emit({ type: 'notice', level: 'warn', text: `${(err as Error).message}; using a mechanical summary instead` });
      summary = [prev?.summary ? `## Earlier summary\n${prev.summary}` : '', fallbackSummary(toSummarize)].filter(Boolean).join('\n\n');
    }
    const keptTokens = liveMessages.slice(cut).reduce((s, m) => s + estimateTextTokens(JSON.stringify(m.content)), 0);
    const tokensAfter = this.systemTokens + summaryTokens(summary) + keptTokens;
    this.session.appendCompaction({ summary, firstKeptId: firstKept, tokensBefore, tokensAfter, reason });
    if (this.memory?.enabled) await this.memory.onPostCompress(summary);
    const post = await this.hooks.emit(this.hookInput('PostCompact', { trigger: reason === 'manual' ? 'manual' : 'auto', compact_summary: summary }), opts.signal);
    const restart = await this.hooks.emit(this.hookInput('SessionStart', { source: 'compact' }), opts.signal);
    this.freezeContext([...post.additionalContext, ...restart.additionalContext]);
    this.emit({ type: 'compaction', phase: 'end', reason, tokensBefore, tokensAfter, summary });
    return { summary, tokensBefore, tokensAfter };
  }

  async undo(): Promise<{ restored: string[]; removed: string[]; prompt: string } | null> {
    if (this.running) throw new Error('cannot undo while running');
    const branch = this.session.branch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.type !== 'custom' || e.kind !== 'snapshot') continue;
      const next = branch[i + 1];
      const prompt = next && next.type === 'message' ? next.text : '';
      const files = this.opts.snapshots ? this.opts.snapshots.restore((e.data as { tree: string }).tree) : { restored: [], removed: [] };
      this.session.rewindTo(e.parentId);
      return { ...files, prompt };
    }
    return null;
  }

  async close(reason = 'exit'): Promise<void> {
    if (this.running) {
      this.abort();
      await this.running.catch(() => {});
    }
    if (!this.started) return;
    await this.hooks.emit(this.hookInput('SessionEnd', { reason }));
    await this.hooks.drain();
    if (this.memory) {
      await this.memory.onSessionEnd(this.session.messages(), reason);
      await this.memory.shutdown();
    }
    this.started = false;
  }
}
