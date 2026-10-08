import { createInterface } from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always errors', inputSchema: { type: 'object', properties: {} } },
];

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' }, instructions: 'Use echo to repeat things.' } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  else if (msg.method === 'tools/call') {
    if (msg.params.name === 'echo') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${msg.params.arguments.text}` }] } });
    else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'it broke' }], isError: true } });
  } else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
});
