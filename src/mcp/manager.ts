import type { Tool, ToolRegistry } from '../agent/tool.ts';
import { textResult } from '../agent/tool.ts';
import { McpClient, type McpServerConfig, type McpTool } from './client.ts';

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

export function wrapMcpTool(client: McpClient, t: McpTool): Tool<Record<string, unknown>> {
  const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { type: 'object', properties: {}, ...t.inputSchema } : { type: 'object', properties: {} };
  return {
    name: mcpToolName(client.name, t.name),
    description: `${t.description ?? t.annotations?.title ?? t.name} (MCP server: ${client.name})`.slice(0, 2000),
    parameters: schema,
    kind: 'mcp',
    concurrent: t.annotations?.readOnlyHint === true,
    target: () => ({ kind: 'mcp', subject: `${client.name}:${t.name}` }),
    async execute(args, ctx) {
      if (!client.connected) return textResult(`MCP server "${client.name}" is disconnected`, true);
      const r = await client.callTool(t.name, args, ctx.signal);
      if (r.structured && !r.content.length) return { content: [{ type: 'text', text: JSON.stringify(r.structured, null, 2) }], isError: r.isError };
      return { content: r.content, isError: r.isError };
    },
  };
}

export interface McpStatus {
  name: string;
  connected: boolean;
  tools: number;
  error?: string;
}

export class McpManager {
  readonly clients = new Map<string, McpClient>();
  readonly status = new Map<string, McpStatus>();

  async connectAll(servers: Record<string, McpServerConfig>, registry: ToolRegistry, opts: { timeoutMs?: number; onError?: (name: string, err: Error) => void } = {}): Promise<McpStatus[]> {
    const entries = Object.entries(servers ?? {}).filter(([, c]) => !c.disabled);
    await Promise.all(
      entries.map(async ([name, cfg]) => {
        const client = new McpClient(name, cfg);
        try {
          await client.connect(opts.timeoutMs ?? 20000);
          const tools = await client.listTools();
          const allowed = cfg.tools ? tools.filter((t) => cfg.tools!.includes(t.name)) : tools;
          for (const t of allowed) registry.register(wrapMcpTool(client, t));
          this.clients.set(name, client);
          this.status.set(name, { name, connected: true, tools: allowed.length });
        } catch (err) {
          await client.close().catch(() => {});
          this.status.set(name, { name, connected: false, tools: 0, error: (err as Error).message });
          opts.onError?.(name, err as Error);
        }
      }),
    );
    return [...this.status.values()];
  }

  instructions(): string {
    const parts = [...this.clients.values()].filter((c) => c.instructions?.trim()).map((c) => `## ${c.name}\n${c.instructions!.trim()}`);
    return parts.length ? `# MCP server instructions\n\n${parts.join('\n\n')}` : '';
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
}
