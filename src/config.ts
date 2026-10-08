import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Model, ProviderConfig, ReasoningLevel } from './ai/types.ts';
import type { PermissionMode } from './agent/permissions.ts';
import type { HooksConfig } from './agent/hooks.ts';
import type { McpServerConfig } from './mcp/client.ts';
import type { EngramOptions } from './memory/engram.ts';
import type { CompactionSettings } from './agent/compaction.ts';
import type { SandboxConfig } from './tools/bash.ts';
import { findGitRoot } from './agent/instructions.ts';

export interface LoomConfig {
  model?: string;
  smallModel?: string;
  reasoning?: ReasoningLevel;
  maxTokens?: number;
  maxTurns?: number;
  toolOutputMaxChars?: number;
  providers?: Record<string, Partial<ProviderConfig>>;
  models?: (Partial<Model> & { id: string; provider: string })[];
  aliases?: Record<string, string>;
  permissions?: { mode?: PermissionMode; allow?: string[]; deny?: string[]; ask?: string[] };
  sandbox?: SandboxConfig;
  hooks?: HooksConfig;
  mcpServers?: Record<string, McpServerConfig>;
  memory?: { provider?: 'engram' | 'none'; recall?: boolean; engram?: EngramOptions };
  compaction?: Partial<CompactionSettings>;
  instructions?: { files?: string[]; global?: boolean; maxChars?: number };
  skills?: { paths?: string[]; enabled?: boolean };
  agents?: { paths?: string[]; maxDepth?: number };
  plugins?: string[];
  systemPrompt?: { base?: string; append?: string };
  tools?: { disabled?: string[] };
  snapshots?: boolean;
}

export function loomHome(): string {
  return process.env.LOOM_HOME || join(homedir(), '.loom');
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not parse ${path}: ${(err as Error).message}`);
  }
}

const CONCAT_KEYS = new Set(['allow', 'deny', 'ask', 'plugins', 'paths', 'files', 'disabled', 'models']);

export function mergeConfig(base: Record<string, any>, over: Record<string, any> | undefined): Record<string, any> {
  if (!over) return base;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (Array.isArray(v) && Array.isArray(b) && CONCAT_KEYS.has(k)) out[k] = [...b, ...v];
    else if (k === 'hooks' && b && v && typeof v === 'object') {
      const merged: Record<string, unknown[]> = { ...b };
      for (const [ev, groups] of Object.entries(v as Record<string, unknown[]>)) merged[ev] = [...((merged[ev] as unknown[]) ?? []), ...groups];
      out[k] = merged;
    } else if (b && v && typeof b === 'object' && typeof v === 'object' && !Array.isArray(b) && !Array.isArray(v)) out[k] = mergeConfig(b, v);
    else out[k] = v;
  }
  return out;
}

export interface ConfigSources {
  config: LoomConfig;
  files: string[];
  projectRoot: string;
}

export function loadConfig(cwd: string, overrides: LoomConfig = {}): ConfigSources {
  const home = loomHome();
  const root = findGitRoot(cwd) ?? cwd;
  const candidates = [join(home, 'config.json'), join(root, '.loom', 'config.json'), join(root, '.loom', 'config.local.json')];
  let cfg: Record<string, any> = {};
  const files: string[] = [];
  for (const f of candidates) {
    const j = readJson(f);
    if (j) {
      cfg = mergeConfig(cfg, j);
      files.push(f);
    }
  }
  const mcpJson = readJson(join(root, '.mcp.json')) as { mcpServers?: Record<string, McpServerConfig> } | undefined;
  if (mcpJson?.mcpServers) {
    cfg.mcpServers = { ...mcpJson.mcpServers, ...cfg.mcpServers };
    files.push(join(root, '.mcp.json'));
  }
  cfg = mergeConfig(cfg, overrides as Record<string, any>);
  if (process.env.LOOM_MODEL && !overrides.model) cfg.model = process.env.LOOM_MODEL;
  return { config: cfg as LoomConfig, files, projectRoot: root };
}
