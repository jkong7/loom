import { Runtime, type Tool, type MemoryProvider } from '../src/index.ts';

const weather: Tool<{ city: string }> = {
  name: 'weather',
  description: 'Get the current weather for a city',
  kind: 'network',
  concurrent: true,
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => `It is 18C and clear in ${city}.`,
};

const notes: string[] = [];
const scratchMemory: MemoryProvider = {
  name: 'scratch',
  isAvailable: async () => true,
  initialize: async () => {},
  systemPromptBlock: async () => (notes.length ? `Things you were told earlier:\n${notes.map((n) => `- ${n}`).join('\n')}` : null),
  prefetch: async (query) => (query.includes('remember') ? 'The user likes short answers.' : null),
  syncTurn: async (turn) => void notes.push(turn.user.slice(0, 120)),
};

const rt = await Runtime.create({
  cwd: process.cwd(),
  model: process.argv[2] ?? 'mock',
  mode: 'acceptEdits',
  config: { permissions: { allow: ['weather'] } },
  memory: [scratchMemory],
  plugins: [(api) => api.registerTool(weather)],
});

const agent = await rt.createAgent();
agent.subscribe((e) => {
  if (e.type === 'message_update' && e.event.type === 'text_delta') process.stdout.write(e.event.delta);
  if (e.type === 'tool_start') process.stdout.write(`\n[tool ${e.call.name}]\n`);
});

const result = await agent.prompt(process.argv[3] ?? 'call weather {"city":"Chicago"}');
process.stdout.write(`\n\n${result.reason} after ${result.turns} turns, session ${agent.session.id}\n`);
await rt.close();
