import type { JsonSchema, ToolSpec, UserContent } from '../ai/types.ts';

export type ToolKind = 'read' | 'edit' | 'execute' | 'network' | 'mcp' | 'agent' | 'memory' | 'other';

export interface ToolResult {
  content: UserContent[];
  isError?: boolean;
  details?: unknown;
}

export interface PermissionTarget {
  kind: ToolKind;
  subject?: string;
  paths?: string[];
  description?: string;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  toolCallId: string;
  depth: number;
  onUpdate?: (text: string) => void;
  services: ToolServices;
}

export interface ToolServices {
  readFiles: Map<string, string>;
  outputDir?: string;
  [key: string]: unknown;
}

export interface Tool<A = Record<string, any>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  kind: ToolKind;
  concurrent?: boolean;
  target?: (args: A, ctx: { cwd: string }) => PermissionTarget;
  execute: (args: A, ctx: ToolContext) => Promise<ToolResult | string>;
}

export function toSpec(t: Tool<any>): ToolSpec {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

export function textResult(text: string, isError = false, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], isError, details };
}

export function normalizeResult(r: ToolResult | string): ToolResult {
  return typeof r === 'string' ? textResult(r) : r;
}

export class ToolError extends Error {}

export class ToolRegistry {
  private tools = new Map<string, Tool<any>>();

  register(tool: Tool<any>): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool<any>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  filter(pred: (t: Tool<any>) => boolean): ToolRegistry {
    const r = new ToolRegistry();
    for (const t of this.tools.values()) if (pred(t)) r.register(t);
    return r;
  }

  specs(): ToolSpec[] {
    const builtin = this.list().filter((t) => !t.name.startsWith('mcp__'));
    const mcp = this.list().filter((t) => t.name.startsWith('mcp__')).sort((a, b) => a.name.localeCompare(b.name));
    return [...builtin, ...mcp].map(toSpec);
  }
}
