import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ReasoningLevel, Usage } from '../ai/types.ts';
import type { Tool } from './tool.ts';
import { textResult } from './tool.ts';
import { parseFrontmatter } from './frontmatter.ts';

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  reasoning?: ReasoningLevel;
  maxTurns?: number;
  source: string;
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general',
    description: 'General-purpose agent for multi-step research or implementation work that would otherwise fill the main context. Has the same tools as the main agent.',
    prompt: 'You are a subagent working on one delegated task. Do the task completely, then reply with a concise report of what you found or changed, including file paths. Your reply is all the caller sees.',
    source: 'builtin',
  },
  {
    name: 'explore',
    description: 'Fast read-only agent for finding code, files and facts across a codebase. Use it for broad searches; it cannot edit files or run commands.',
    prompt: 'You are a read-only exploration subagent. Search widely with grep, glob and read, then reply with precise findings: file paths with line numbers and short excerpts. Do not speculate beyond what you read.',
    tools: ['read', 'grep', 'glob', 'skill'],
    reasoning: 'low',
    source: 'builtin',
  },
];

export function loadAgentDefinitions(dirs: string[]): AgentDefinition[] {
  const out = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      try {
        const { data, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, f), 'utf8'));
        const name = String(data.name || basename(f, '.md'));
        const tools = Array.isArray(data.tools) ? data.tools.map(String) : typeof data.tools === 'string' && data.tools ? data.tools.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
        out.set(name, {
          name,
          description: String(data.description || ''),
          prompt: body.trim(),
          tools,
          model: data.model ? String(data.model) : undefined,
          reasoning: data.reasoning ? (String(data.reasoning) as ReasoningLevel) : undefined,
          maxTurns: typeof data.maxTurns === 'number' ? data.maxTurns : undefined,
          source: join(dir, f),
        });
      } catch {}
    }
  }
  return [...out.values()];
}

export function renderAgentIndex(defs: AgentDefinition[]): string {
  if (!defs.length) return '';
  return `# Subagents\n\nThe task tool delegates work to a subagent with its own fresh context. Use it for broad searches and self-contained subtasks so your own context stays focused; run several in parallel when the subtasks are independent. Give each a complete, self-contained prompt.\n\n${defs.map((d) => `- ${d.name}: ${d.description}`).join('\n')}`;
}

export interface SubagentResult {
  text: string;
  sessionId: string;
  reason: string;
  turns: number;
  usage: Usage;
}

export type SubagentSpawner = (def: AgentDefinition, prompt: string, opts: { signal: AbortSignal; depth: number; parentSessionId: string; description?: string }) => Promise<SubagentResult>;

export function taskTool(defs: AgentDefinition[], maxDepth = 2): Tool<{ description: string; prompt: string; agent?: string }> {
  return {
    name: 'task',
    kind: 'agent',
    concurrent: true,
    description: `Delegate a self-contained task to a subagent with a fresh context and get back its final report. Agents: ${defs.map((d) => d.name).join(', ')} (default general). The subagent cannot see this conversation, so put everything it needs in prompt.`,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Three to six word label for the task' },
        prompt: { type: 'string', description: 'Complete instructions for the subagent' },
        agent: { type: 'string', enum: defs.map((d) => d.name) },
      },
      required: ['description', 'prompt'],
    },
    async execute(a, ctx) {
      const spawn = ctx.services.spawnSubagent as SubagentSpawner | undefined;
      if (!spawn) return textResult('Subagents are not available in this runtime.', true);
      if (ctx.depth + 1 > maxDepth) return textResult(`Subagent depth limit (${maxDepth}) reached; do this task yourself.`, true);
      const def = defs.find((d) => d.name === (a.agent ?? 'general'));
      if (!def) return textResult(`Unknown agent "${a.agent}"`, true);
      const r = await spawn(def, a.prompt, { signal: ctx.signal, depth: ctx.depth + 1, parentSessionId: ctx.sessionId, description: a.description });
      const footer = `\n\n[subagent ${def.name} finished: ${r.reason}, ${r.turns} turns, session ${r.sessionId}]`;
      return textResult((r.text || '(no report)') + footer, r.reason !== 'done', r);
    },
  };
}
