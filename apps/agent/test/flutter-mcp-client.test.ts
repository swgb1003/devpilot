import assert from 'node:assert/strict';
import test from 'node:test';

import { FlutterMcpStdioScreenshotClient } from '../src/flutter-mcp-client.js';

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
]);

const fixture = `
const readline = require('node:readline');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2025-03-26' });
  if (request.method !== 'tools/call') return;
  const args = request.params.arguments;
  if (args.command === 'listDtdUris') return reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ dtdUris: ['ws://dtd.example/'] }) }] });
  if (args.command === 'connect') return reply(request.id, { content: [{ type: 'text', text: 'connected' }] });
  if (args.command === 'listConnectedApps') return reply(request.id, { content: [{ type: 'text', text: JSON.stringify([{ appUri: 'http://app.example/', deviceId: 'device-123' }]) }] });
  if (request.params.name === 'flutter_driver_command') return reply(request.id, { content: [{ type: 'image', mimeType: 'image/png', data: '${png.toString('base64')}' }] });
});
`;

test('Flutter MCP client discovers the matching app and returns only a PNG image', async () => {
  const client = new FlutterMcpStdioScreenshotClient({
    executable: process.execPath,
    arguments: ['-e', fixture],
    requestTimeoutMs: 1_000,
  });

  assert.deepEqual(await client.captureScreenshot('device-123'), png);
});
