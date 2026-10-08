import type { Plugin } from '../src/index.ts';

const plugin: Plugin = (api) => {
  api.registerTool({
    name: 'now',
    description: 'Current date and time in ISO format',
    kind: 'read',
    concurrent: true,
    parameters: { type: 'object', properties: {} },
    execute: async () => new Date().toISOString(),
  });

  api.on('PreToolUse', (input) => {
    const cmd = String((input.tool_input as { command?: string })?.command ?? '');
    if (/\brm\s+-rf\s+\/(\s|$)/.test(cmd)) return { decision: 'deny', reason: 'refusing to delete the filesystem root' };
  }, { matcher: 'bash' });

  api.registerProvider({ id: 'together', api: 'openai-chat', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: ['TOGETHER_API_KEY'] });

  api.addSystemPrompt('When you finish a coding task, list the files you changed.');
};

export default plugin;
