import assert from 'node:assert/strict';
import { get as httpsGet } from 'node:https';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { generate } from 'selfsigned';

import { runBinaryCommand } from '../src/command.ts';
import { loadAgentConfig } from '../src/config.ts';
import { createAgentServer, listen } from '../src/server.ts';

const desktopToken = 'desktop-test-token-00000000000000';

function authorizationHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${desktopToken}`,
    'content-type': 'application/json',
  };
}

function testConfig() {
  return {
    ...loadAgentConfig({
      DEVPILOT_AGENT_PORT: '47831',
      DEVPILOT_DESKTOP_TOKEN: desktopToken,
      DEVPILOT_DATA_DIR: '.unused-test-data',
    }),
    databasePath: ':memory:',
  };
}

test('runBinaryCommand preserves binary stdout', async () => {
  const result = await runBinaryCommand(
    process.execPath,
    ['-e', 'process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]))'],
    2_000,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.deepEqual([...result.stdout], [0x89, 0x50, 0x4e, 0x47]);
});

test('M2 API requires Desktop bearer authentication', async (context) => {
  const server = createAgentServer({ config: testConfig() });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/config`);
  const body = (await response.json()) as { error: { code: string; traceId: string } };

  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'AUTH_REQUIRED');
  assert.ok(body.error.traceId.length > 0);
});

test('M2 Activity API persists and lists validated activities', async (context) => {
  const server = createAgentServer({ config: testConfig() });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${baseUrl}/api/v1/activities`, {
    method: 'POST',
    headers: authorizationHeaders(),
    body: JSON.stringify({
      kind: 'user.note',
      severity: 'success',
      message: 'M2 activity contract',
      metadata: { scope: 'test' },
    }),
  });
  assert.equal(created.status, 201);

  const listed = await fetch(`${baseUrl}/api/v1/activities`, {
    headers: authorizationHeaders(),
  });
  const body = (await listed.json()) as { data: Array<{ message: string; severity: string }> };
  assert.equal(listed.status, 200);
  assert.deepEqual(
    body.data.map((activity) => ({
      message: activity.message,
      severity: activity.severity,
    })),
    [{ message: 'M2 activity contract', severity: 'success' }],
  );
});

test('M2 WebSocket ticket is one-time and streams Activity events', async (context) => {
  const server = createAgentServer({ config: testConfig() });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const ticketResponse = await fetch(`${baseUrl}/api/v1/ws-tickets`, {
    method: 'POST',
    headers: authorizationHeaders(),
  });
  const ticketBody = (await ticketResponse.json()) as { data: { ticket: string } };
  const websocket = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/v1/events?ticket=${ticketBody.data.ticket}`,
  );
  context.after(() => websocket.close());
  await new Promise<void>((resolve, reject) => {
    websocket.addEventListener('open', () => resolve(), { once: true });
    websocket.addEventListener('error', () => reject(new Error('WebSocket failed to open.')), {
      once: true,
    });
  });

  const eventPromise = new Promise<{
    eventType: string;
    sequence: number;
    payload: { message: string };
  }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Activity event timed out.')), 2_000);
    websocket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(
          JSON.parse(String(event.data)) as {
            eventType: string;
            sequence: number;
            payload: { message: string };
          },
        );
      },
      { once: true },
    );
  });
  await fetch(`${baseUrl}/api/v1/activities`, {
    method: 'POST',
    headers: authorizationHeaders(),
    body: JSON.stringify({ kind: 'user.note', message: 'stream me' }),
  });

  const event = await eventPromise;
  assert.equal(event.eventType, 'activity.created');
  assert.equal(event.sequence, 1);
  assert.equal(event.payload.message, 'stream me');
});

test('GET /health reports a ready agent', async (context) => {
  const server = createAgentServer();
  context.after(() => server.close());

  await listen(server, 0);
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = (await response.json()) as {
    data: { name: string; protocolVersion: number; status: string };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(
    {
      name: body.data.name,
      protocolVersion: body.data.protocolVersion,
      status: body.data.status,
    },
    {
      name: 'devpilot-agent',
      protocolVersion: 1,
      status: 'ready',
    },
  );
});

test('M2 core can serve the same API and WebSocket upgrade surface over TLS', async (context) => {
  const certificate = await generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    keySize: 2048,
  });
  const server = createAgentServer({
    config: testConfig(),
    tls: { cert: certificate.cert, key: certificate.private },
  });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;

  const result = await new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const request = httpsGet(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/health',
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () =>
            resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      request.once('error', reject);
    },
  );

  assert.equal(result.status, 200);
  assert.equal((JSON.parse(result.body) as { data: { version: string } }).data.version, '0.2.0');
  assert.ok(server.listenerCount('upgrade') > 0);
});
