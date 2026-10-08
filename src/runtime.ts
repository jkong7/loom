import { join } from 'node:path';
import type { Model, ReasoningLevel } from './ai/types.ts';
import { ModelRegistry } from './ai/registry.ts';
import { Agent, type AgentOptions } from './agent/agent.ts';
import { ToolRegistry } from './agent/tool.ts';
import { PermissionPolicy, type Asker, type PermissionMode } from './agent/permissions.ts';
import { HookBus } from './agent/hooks.ts';
import { Session, SessionStore } from './agent/session.ts';
import { findGitRoot, loadInstructions, renderInstructions } from './agent/instructions.ts';
import { discoverSkills, renderSkillIndex, skillTool, type Skill } from './agent/skills.ts';
import { loadAgentDefinitions, renderAgentIndex, taskTool, type AgentDefinition, type SubagentSpawner, type SubagentResult } from './agent/subagents.ts';
import { builtinTools, killAllJobs } from './tools/index.ts';
import { McpManager } from './mcp/manager.ts';
import { MemoryManager } from './memory/manager.ts';
import { EngramProvider } from './memory/engram.ts';
import type { MemoryProvider } from './memory/provider.ts';
import { loadConfig, loomHome, type LoomConfig } from './config.ts';
import { loadPlugins, pluginPaths, type Plugin, type PluginHost } from './plugins.ts';
import { textOf } from './ai/types.ts';

export interface RuntimeOptions {
  cwd?: string;
  config?: LoomConfig;
  home?: string;
  model?: string;
  mode?: PermissionMode;
  asker?: Asker;
  memory?: boolean | MemoryProvider[];
  mcp?: boolean;
  plugins?: Plugin[];
  loadPlugins?: boolean;
  registry?: ModelRegistry;
  onWarning?: (text: string) => void;
}

export interface NewAgentOptions {
  session?: Session;
  resume?: string | 'latest';
  fork?: { session: string; entryId?: string };
  model?: string;
  reasoning?: ReasoningLevel;
  agentContext?: AgentOptions['agentContext'];
  extra?: Partial<AgentOptions>;
}

export class Runtime {
  readonly cwd: string;
  readonly home: string;
  readonly config: LoomConfig;
  readonly configFiles: string[];
  readonly registry: ModelRegistry;
  readonly hooks: HookBus;
  readonly tools: ToolRegistry;
  readonly permissions: PermissionPolicy;
  readonly sessions: SessionStore;
  readonly mcp = new McpManager();
  readonly memoryProviders: MemoryProvider[] = [];
  readonly pluginHost: PluginHost;
  skills: Skill[] = [];
  agentDefs: AgentDefinition[] = [];
  private promptExtras: string[] = [];
  private opts: RuntimeOptions;
  private agents = new Set<Agent>();
  warnings: string[] = [];

  private constructor(opts: RuntimeOptions) {
    this.opts = opts;
    this.cwd = opts.cwd ?? process.cwd();
    this.home = opts.home ?? loomHome();
    const loaded = loadConfig(this.cwd, opts.config);
    this.config = loaded.config;
    this.configFiles = loaded.files;
    this.registry = opts.registry ?? new ModelRegistry();
    for (const [id, p] of Object.entries(this.config.providers ?? {})) {
      const prev = this.registry.provider(id);
      if (!prev && (!p.api || !p.baseUrl)) {
        this.warn(`provider "${id}" needs api and baseUrl`);
        continue;
      }
      this.registry.addProvider({ ...(prev ?? {}), ...p, id } as never);
    }
    for (const m of this.config.models ?? []) {
      try {
        this.registry.addModel(m);
      } catch (err) {
        this.warn((err as Error).message);
      }
    }
    Object.assign(this.registry.aliases, this.config.aliases ?? {});
    this.hooks = new HookBus();
    this.hooks.loadConfig(this.config.hooks);
    this.hooks.onError = (name, err) => this.warn(`hook ${name} failed: ${(err as Error).message}`);
    this.tools = builtinTools({ exclude: this.config.tools?.disabled });
    const sandbox = this.config.sandbox;
    this.permissions = new PermissionPolicy({ mode: opts.mode ?? this.config.permissions?.mode, rules: this.config.permissions, asker: opts.asker });
    this.sessions = new SessionStore(join(this.home, 'sessions'));
    this.pluginHost = { tools: this.tools, hooks: this.hooks, registry: this.registry, memoryProviders: this.memoryProviders, systemPrompt: this.promptExtras, loaded: [], errors: [] };
    if (sandbox) this.sandbox = sandbox;
  }

  sandbox?: LoomConfig['sandbox'];

  warn(text: string): void {
    this.warnings.push(text);
    this.opts.onWarning?.(text);
  }

  static async create(opts: RuntimeOptions = {}): Promise<Runtime> {
    const rt = new Runtime(opts);
    await rt.init();
    return rt;
  }

  private async init(): Promise<void> {
    const projectRoot = findGitRoot(this.cwd) ?? this.cwd;
    if (this.opts.loadPlugins !== false) {
      const paths = pluginPaths([join(this.home, 'plugins'), join(projectRoot, '.loom', 'plugins')], this.config.plugins ?? [], this.cwd);
      await loadPlugins(paths, this.pluginHost, this.cwd, this.config, this.opts.plugins ?? []);
    } else if (this.opts.plugins?.length) await loadPlugins([], this.pluginHost, this.cwd, this.config, this.opts.plugins);
    for (const e of this.pluginHost.errors) this.warn(`plugin ${e.path}: ${e.error}`);

    if (this.config.skills?.enabled !== false) {
      const dirs = [join(this.home, 'skills'), join(projectRoot, '.loom', 'skills'), join(projectRoot, '.agents', 'skills'), join(projectRoot, '.claude', 'skills'), ...(this.config.skills?.paths ?? []).map((p) => p.replace(/^~/, process.env.HOME ?? ''))];
      this.skills = discoverSkills(dirs);
      if (this.skills.length) this.tools.register(skillTool(this.skills));
    }
    this.agentDefs = loadAgentDefinitions([join(this.home, 'agents'), join(projectRoot, '.loom', 'agents'), ...(this.config.agents?.paths ?? [])]);
    this.tools.register(taskTool(this.agentDefs, this.config.agents?.maxDepth ?? 2));

    if (this.opts.mcp !== false && this.config.mcpServers && Object.keys(this.config.mcpServers).length) {
      await this.mcp.connectAll(this.config.mcpServers, this.tools, { onError: (name, err) => this.warn(`MCP server ${name}: ${err.message}`) });
    }

    const mem = this.opts.memory;
    if (Array.isArray(mem)) this.memoryProviders.push(...mem);
    else if (mem !== false && (this.config.memory?.provider ?? 'engram') === 'engram') this.memoryProviders.unshift(new EngramProvider({ harness: 'loom', ...this.config.memory?.engram }));
  }

  resolveModel(spec?: string): Model {
    const s = spec ?? this.opts.model ?? this.config.model ?? process.env.LOOM_MODEL ?? defaultModelSpec(this.registry);
    return this.registry.resolve(s);
  }

  promptParts(): AgentOptions['prompt'] {
    const files = loadInstructions({ cwd: this.cwd, home: this.config.instructions?.global === false ? undefined : this.home, fileNames: this.config.instructions?.files, maxChars: this.config.instructions?.maxChars });
    const mcpText = this.mcp.instructions();
    return {
      base: this.config.systemPrompt?.base,
      append: this.config.systemPrompt?.append,
      instructions: renderInstructions(files),
      skills: renderSkillIndex(this.skills),
      agents: renderAgentIndex(this.agentDefs),
      extra: [...this.promptExtras, mcpText].filter(Boolean),
    };
  }

  openSession(opts: NewAgentOptions, model: Model): Session {
    if (opts.session) return opts.session;
    if (opts.fork) {
      const src = this.sessions.find(opts.fork.session);
      if (!src) throw new Error(`no session ${opts.fork.session}`);
      return src.fork(this.sessions.root, opts.fork.entryId);
    }
    if (opts.resume) {
      const s = opts.resume === 'latest' ? this.sessions.latest(this.cwd) : this.sessions.find(opts.resume);
      if (!s) throw new Error(opts.resume === 'latest' ? `no previous session in ${this.cwd}` : `no session ${opts.resume}`);
      return s;
    }
    return this.sessions.create({ cwd: this.cwd, model: `${model.provider}/${model.id}` });
  }

  async createAgent(opts: NewAgentOptions = {}): Promise<Agent> {
    let model = this.resolveModel(opts.model);
    const session = this.openSession(opts, model);
    if (!opts.model && (opts.resume || opts.fork)) {
      const prev = session.lastModel();
      if (prev) {
        try {
          model = this.registry.resolve(prev);
        } catch {}
      }
    }
    const memory = this.memoryProviders.length ? new MemoryManager(this.memoryProviders, { recall: this.config.memory?.recall !== false, onError: (p, phase, err) => this.warn(`memory ${p} ${phase}: ${(err as Error).message}`) }) : undefined;
    const small = this.config.smallModel ? this.resolveModel(this.config.smallModel) : undefined;
    const agent: Agent = new Agent({
      model,
      registry: this.registry,
      session,
      tools: this.tools,
      permissions: this.permissions,
      hooks: this.hooks,
      memory,
      prompt: this.promptParts(),
      reasoning: opts.reasoning ?? this.config.reasoning,
      maxTokens: this.config.maxTokens,
      maxTurns: this.config.maxTurns,
      toolOutputMaxChars: this.config.toolOutputMaxChars,
      compaction: this.config.compaction,
      compactionModel: small,
      agentContext: opts.agentContext ?? 'primary',
      services: { sandbox: this.sandbox, spawnSubagent: this.spawner(() => agent) },
      ...opts.extra,
    });
    this.agents.add(agent);
    return agent;
  }

  spawner(parent: () => Agent): SubagentSpawner {
    return async (def, prompt, o): Promise<SubagentResult> => {
      const p = parent();
      const model = def.model ? this.resolveModel(def.model) : p.model;
      const allowed = def.tools;
      const tools = this.tools.filter((t) => (!allowed || allowed.includes(t.name)) && (t.name !== 'task' || o.depth < (this.config.agents?.maxDepth ?? 2)) && t.kind !== 'memory');
      const session = this.sessions.create({ cwd: this.cwd, model: `${model.provider}/${model.id}`, parentSession: o.parentSessionId, agent: def.name });
      const child: Agent = new Agent({
        model,
        registry: this.registry,
        session,
        tools,
        permissions: this.permissions,
        hooks: this.hooks,
        prompt: { ...this.promptParts(), append: [this.config.systemPrompt?.append, `# Subagent role: ${def.name}\n\n${def.prompt}`].filter(Boolean).join('\n\n'), skills: allowed && !allowed.includes('skill') ? undefined : renderSkillIndex(this.skills), agents: undefined },
        reasoning: def.reasoning ?? p.opts.reasoning,
        maxTurns: def.maxTurns ?? this.config.maxTurns ?? 100,
        toolOutputMaxChars: this.config.toolOutputMaxChars,
        compaction: this.config.compaction,
        depth: o.depth,
        agentContext: 'subagent',
        services: { sandbox: this.sandbox, spawnSubagent: this.spawner(() => child) },
      });
      const forward = child.subscribe((e) => {
        if (e.type === 'tool_start') p.notify('info', `[${def.name}] ${e.call.name} ${JSON.stringify(e.call.args).slice(0, 80)}`);
      });
      try {
        const r = await child.prompt(prompt, { signal: o.signal });
        const result = { text: r.text || (r.message ? textOf(r.message.content) : ''), sessionId: session.id, reason: r.reason, turns: r.turns, usage: r.usage };
        await p.memory?.onDelegation({ task: prompt, result: result.text, childSessionId: session.id });
        return result;
      } finally {
        forward();
        await child.close('subagent-done');
      }
    };
  }

  async close(): Promise<void> {
    for (const a of this.agents) await a.close().catch(() => {});
    this.agents.clear();
    await this.mcp.closeAll();
    killAllJobs();
  }
}

export function defaultModelSpec(registry: ModelRegistry): string {
  const has = (env: string[]) => env.some((e) => process.env[e]);
  if (has(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])) return 'anthropic/claude-opus-5-5';
  if (has(['OPENAI_API_KEY'])) return 'openai/gpt-5';
  if (has(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])) return 'google/gemini-2.5-pro';
  if (has(['OPENROUTER_API_KEY'])) return 'openrouter/anthropic/claude-sonnet-5-5';
  void registry;
  return 'ollama/qwen3:8b';
}
