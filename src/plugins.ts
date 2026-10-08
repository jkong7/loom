import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderConfig, StreamFn } from './ai/types.ts';
import { registerApi, type ModelRegistry } from './ai/registry.ts';
import type { Tool, ToolRegistry } from './agent/tool.ts';
import type { HookBus, HookEvent, HookHandler } from './agent/hooks.ts';
import type { MemoryProvider } from './memory/provider.ts';
import type { LoomConfig } from './config.ts';

export interface PluginApi {
  cwd: string;
  config: LoomConfig;
  registerTool(tool: Tool<any>): void;
  on(event: HookEvent, handler: HookHandler, opts?: { matcher?: string; async?: boolean }): void;
  registerProvider(provider: ProviderConfig): void;
  registerApi(api: string, stream: StreamFn): void;
  registerModel(model: Parameters<ModelRegistry['addModel']>[0]): void;
  registerMemoryProvider(provider: MemoryProvider): void;
  addSystemPrompt(text: string): void;
  log(...args: unknown[]): void;
}

export type Plugin = (api: PluginApi) => void | Promise<void>;

export interface PluginHost {
  tools: ToolRegistry;
  hooks: HookBus;
  registry: ModelRegistry;
  memoryProviders: MemoryProvider[];
  systemPrompt: string[];
  loaded: string[];
  errors: { path: string; error: string }[];
}

export function pluginPaths(dirs: string[], explicit: string[], cwd: string): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) if (/\.(m?js|ts)$/.test(f)) out.push(join(d, f));
  }
  for (const p of explicit) out.push(isAbsolute(p) ? p : resolve(cwd, p));
  return [...new Set(out)];
}

export async function loadPlugins(paths: string[], host: PluginHost, cwd: string, config: LoomConfig, inline: Plugin[] = []): Promise<void> {
  const api: PluginApi = {
    cwd,
    config,
    registerTool: (t) => void host.tools.register(t),
    on: (event, handler, opts) => void host.hooks.on(event, handler, { ...opts, name: `plugin:${event}` }),
    registerProvider: (p) => host.registry.addProvider(p),
    registerApi: (a, fn) => registerApi(a, fn),
    registerModel: (m) => void host.registry.addModel(m),
    registerMemoryProvider: (p) => void host.memoryProviders.push(p),
    addSystemPrompt: (t) => void host.systemPrompt.push(t),
    log: (...args) => {
      if (process.env.LOOM_DEBUG) console.error('[plugin]', ...args);
    },
  };
  for (const fn of inline) await fn(api);
  for (const p of paths) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const fn: Plugin | undefined = typeof mod.default === 'function' ? mod.default : typeof mod.plugin === 'function' ? mod.plugin : undefined;
      if (!fn) throw new Error('plugin must export a default function (api) => void');
      await fn(api);
      host.loaded.push(p);
    } catch (err) {
      host.errors.push({ path: p, error: (err as Error).message });
    }
  }
}
