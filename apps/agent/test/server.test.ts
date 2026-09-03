import assert from 'node:assert/strict';
import { get as httpsGet } from 'node:https';
import { randomBytes } from 'node:crypto';
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

test('Desktop control routes reject tokenless loopback requests and unknown Origins', async (context) => {
  const server = createAgentServer({ config: testConfig() });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [path, method] of [
    ['/api/v1/projects', 'GET'],
    ['/api/v1/diagnostics', 'GET'],
    ['/api/v1/pairings', 'POST'],
  ] as const) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  }

  const untrustedOrigin = await fetch(`${baseUrl}/api/v1/projects`, {
    headers: { ...authorizationHeaders(), origin: 'https://untrusted.example' },
  });
  const untrustedBody = (await untrustedOrigin.json()) as { error: { code: string } };
  assert.equal(untrustedOrigin.status, 403);
  assert.equal(untrustedBody.error.code, 'AUTH_INVALID');
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

test('M3 API requires Desktop approval before a mobile receives its secure token', async (context) => {
  const server = createAgentServer({
    config: testConfig(),
    pairingEndpoint: {
      hostCandidates: ['192.168.1.20'],
      port: 47_832,
      fingerprint: 'sha256/ABCDEF',
    },
    pairingTokenKey: randomBytes(32),
  });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${baseUrl}/api/v1/pairings`, {
    method: 'POST',
    headers: authorizationHeaders(),
  });
  assert.equal(created.status, 201);
  const challenge = (await created.json()) as {
    data: { id: string; qrPayload: { nonce: string } };
  };

  const confirmed = await fetch(`${baseUrl}/api/v1/pairings/${challenge.data.id}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nonce: challenge.data.qrPayload.nonce,
      displayName: 'Pixel 9 Pro',
      publicKey: 'ed25519-public-key-material-000000000000000000',
    }),
  });
  assert.equal(confirmed.status, 202);
  const confirmedBody = (await confirmed.json()) as {
    data: { confirmationTicket: string; state: { status: string } };
  };
  assert.equal(confirmedBody.data.state.status, 'awaiting_approval');

  const beforeApproval = await fetch(`${baseUrl}/api/v1/pairings/${challenge.data.id}/delivery`, {
    headers: { 'x-devpilot-confirmation': confirmedBody.data.confirmationTicket },
  });
  const beforeApprovalBody = (await beforeApproval.json()) as {
    data: { state: { status: string }; tokens?: unknown };
  };
  assert.equal(beforeApproval.status, 200);
  assert.equal(beforeApprovalBody.data.state.status, 'awaiting_approval');
  assert.equal(beforeApprovalBody.data.tokens, undefined);

  const approved = await fetch(`${baseUrl}/api/v1/pairings/${challenge.data.id}/approve`, {
    method: 'POST',
    headers: authorizationHeaders(),
  });
  assert.equal(approved.status, 200);

  const delivered = await fetch(`${baseUrl}/api/v1/pairings/${challenge.data.id}/delivery`, {
    headers: { 'x-devpilot-confirmation': confirmedBody.data.confirmationTicket },
  });
  const deliveredBody = (await delivered.json()) as {
    data: { tokens: { accessToken: string; refreshToken: string } };
  };
  assert.equal(delivered.status, 200);
  assert.ok(deliveredBody.data.tokens.accessToken.startsWith('dpa_'));

  const reconnect = await fetch(`${baseUrl}/api/v1/pairings/me`, {
    headers: { authorization: `Bearer ${deliveredBody.data.tokens.accessToken}` },
  });
  assert.equal(reconnect.status, 200);

  const replay = await fetch(`${baseUrl}/api/v1/pairings/${challenge.data.id}/delivery`, {
    headers: { 'x-devpilot-confirmation': confirmedBody.data.confirmationTicket },
  });
  assert.equal(replay.status, 401);
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

test('M9 diagnostics gives a concrete recovery action when no session is running', async (context) => {
  const server = createAgentServer({ config: testConfig() });
  context.after(() => server.close());
  await listen(server, 0);
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`, {
    headers: authorizationHeaders(),
  });
  const body = (await response.json()) as {
    data: {
      agent: { status: string; version: string };
      session: unknown;
      recovery: { action: string; title: string; message: string };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.agent.status, 'ready');
  assert.equal(body.data.session, null);
  assert.equal(body.data.recovery.action, 'open_session');
  assert.ok(body.data.recovery.title.length > 0);
  assert.ok(body.data.recovery.message.length > 0);
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
  assert.equal((JSON.parse(result.body) as { data: { version: string } }).data.version, '0.3.0');
  assert.ok(server.listenerCount('upgrade') > 0);
});
