import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type ServerOptions as TlsServerOptions,
} from 'node:https';

import {
  activityKinds,
  createAgentHealth,
  type ActivityKind,
  type ActivitySeverity,
  type AgentPublicConfig,
  type CreateActivityInput,
} from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { requireDesktopToken, WsTicketStore } from './auth.js';
import { loadAgentConfig, type AgentConfig } from './config.js';
import { AgentError, toErrorResponse } from './errors.js';
import { PairingService, type PairingEndpoint } from './pairing-service.js';
import { PairingStore } from './pairing-store.js';
import { createM1ProbeReport } from './probes.js';
import { AgentEventHub } from './websocket.js';

export interface CreateAgentServerOptions {
  readonly config?: AgentConfig;
  readonly activityStore?: ActivityStore;
  readonly tls?: TlsServerOptions;
  readonly pairingEndpoint?: PairingEndpoint;
  readonly pairingService?: PairingService;
  readonly pairingTokenKey?: Buffer;
}

function jsonHeaders(request: IncomingMessage, config: AgentConfig): Record<string, string> {
  const origin = request.headers.origin;
  return {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...(origin && config.allowedOrigins.includes(origin)
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {}),
  };
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  config: AgentConfig,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, jsonHeaders(request, config));
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) {
      throw new AgentError({
        code: 'REQUEST_INVALID',
        message: 'リクエスト本文が大きすぎます。',
        status: 413,
        action: 'CHECK_REQUEST',
      });
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AgentError({
      code: 'REQUEST_INVALID',
      message: 'JSONリクエストを解釈できません。',
      status: 400,
      action: 'CHECK_REQUEST',
    });
  }
}

function parseActivityInput(value: unknown): CreateActivityInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentError({
      code: 'REQUEST_INVALID',
      message: 'Activityの入力形式が正しくありません。',
      status: 400,
      action: 'CHECK_REQUEST',
    });
  }
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  const message = candidate.message;
  const severity = candidate.severity ?? 'info';
  const validSeverity = ['info', 'success', 'warning', 'error'].includes(String(severity));
  const metadata = candidate.metadata;
  if (
    typeof kind !== 'string' ||
    !activityKinds.includes(kind as ActivityKind) ||
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > 500 ||
    !validSeverity ||
    (metadata !== undefined &&
      (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)))
  ) {
    throw new AgentError({
      code: 'REQUEST_INVALID',
      message: 'Activityのkind、severity、message、metadataを確認してください。',
      status: 400,
      action: 'CHECK_REQUEST',
    });
  }

  return {
    kind: kind as ActivityKind,
    message: message.trim(),
    severity: severity as ActivitySeverity,
    ...(metadata ? { metadata: metadata as Readonly<Record<string, unknown>> } : {}),
  };
}

function parsePairingConfirmation(value: unknown): {
  readonly nonce: string;
  readonly displayName: string;
  readonly publicKey: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentError({
      code: 'REQUEST_INVALID',
      message: 'ペアリング確認の入力形式が正しくありません。',
      status: 400,
      action: 'CHECK_REQUEST',
    });
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.nonce !== 'string' ||
    typeof candidate.displayName !== 'string' ||
    typeof candidate.publicKey !== 'string'
  ) {
    throw new AgentError({
      code: 'REQUEST_INVALID',
      message: 'ペアリング確認の必須項目が不足しています。',
      status: 400,
      action: 'CHECK_REQUEST',
    });
  }
  return {
    nonce: candidate.nonce,
    displayName: candidate.displayName,
    publicKey: candidate.publicKey,
  };
}

function requireBearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ')) {
    throw new AgentError({
      code: 'AUTH_REQUIRED',
      message: '端末認証が必要です。',
      status: 401,
      action: 'REAUTHENTICATE',
    });
  }
  return authorization.slice('Bearer '.length);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createAgentServer(options: CreateAgentServerOptions = {}): Server {
  const loadedConfig = options.config ?? loadAgentConfig();
  const config = options.config ? loadedConfig : { ...loadedConfig, databasePath: ':memory:' };
  const ownsStore = options.activityStore === undefined;
  const activities = options.activityStore ?? new ActivityStore(config.databasePath);
  const ownsPairingService = options.pairingService === undefined;
  const pairingService =
    options.pairingService ??
    new PairingService(
      new PairingStore(config.databasePath, options.pairingTokenKey ?? randomBytes(32)),
      activities,
      options.pairingEndpoint ?? {
        hostCandidates: [],
        port: config.port,
        fingerprint: 'sha256/unconfigured',
      },
    );
  const tickets = new WsTicketStore();
  const eventHub = new AgentEventHub();
  const unsubscribe = activities.subscribe((activity) => eventHub.publishActivity(activity));

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      const traceId = randomUUID();
      try {
        const url = new URL(request.url ?? '/', `http://${config.host}:${config.port}`);
        if (request.method === 'OPTIONS') {
          response.writeHead(204, {
            ...jsonHeaders(request, config),
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers': 'Authorization, Content-Type, X-DevPilot-Confirmation',
            'access-control-max-age': '600',
          });
          response.end();
          return;
        }

        if (request.method === 'GET' && url.pathname === '/health') {
          sendJson(request, response, config, 200, { data: createAgentHealth('0.3.0') });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/m1/report') {
          const report = await createM1ProbeReport();
          sendJson(request, response, config, 200, { data: report });
          return;
        }

        const pairingConfirmMatch = /^\/api\/v1\/pairings\/([^/]+)\/confirm$/.exec(url.pathname);
        const pairingDeliveryMatch = /^\/api\/v1\/pairings\/([^/]+)\/delivery$/.exec(url.pathname);
        const pairingStatusMatch = /^\/api\/v1\/pairings\/([^/]+)$/.exec(url.pathname);
        const pairingApproveMatch = /^\/api\/v1\/pairings\/([^/]+)\/approve$/.exec(url.pathname);

        if (request.method === 'POST' && pairingConfirmMatch) {
          const result = pairingService.confirm(
            pairingConfirmMatch[1]!,
            parsePairingConfirmation(await readJson(request)),
          );
          sendJson(request, response, config, 202, {
            data: { state: result.state, confirmationTicket: result.confirmationTicket },
          });
          return;
        }

        if (request.method === 'GET' && pairingDeliveryMatch) {
          const supplied = request.headers['x-devpilot-confirmation'];
          const confirmationTicket = Array.isArray(supplied) ? supplied[0] : supplied;
          if (!confirmationTicket) {
            throw new AgentError({
              code: 'AUTH_REQUIRED',
              message: 'ペアリング確認情報が必要です。',
              status: 401,
              action: 'REAUTHENTICATE',
            });
          }
          sendJson(request, response, config, 200, {
            data: pairingService.statusForMobile(pairingDeliveryMatch[1]!, confirmationTicket),
          });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/v1/auth/refresh') {
          sendJson(request, response, config, 200, {
            data: pairingService.refresh(requireBearerToken(request.headers.authorization)),
          });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/v1/pairings/me') {
          const device = pairingService.authenticate(
            requireBearerToken(request.headers.authorization),
          );
          sendJson(request, response, config, 200, { data: { deviceId: device.deviceId } });
          return;
        }

        if (request.method === 'DELETE' && url.pathname === '/api/v1/pairings/me') {
          const device = pairingService.authenticate(
            requireBearerToken(request.headers.authorization),
          );
          pairingService.revoke(device.deviceId);
          response.writeHead(204, jsonHeaders(request, config));
          response.end();
          return;
        }

        const desktopPairingControl =
          (request.method === 'POST' && url.pathname === '/api/v1/pairings') ||
          (request.method === 'GET' && pairingStatusMatch !== null) ||
          (request.method === 'POST' && pairingApproveMatch !== null);
        if (
          url.pathname.startsWith('/api/v1/') &&
          !(desktopPairingControl && isLoopbackRequest(request))
        ) {
          requireDesktopToken(request.headers.authorization, config.desktopToken);
        }

        if (request.method === 'POST' && url.pathname === '/api/v1/pairings') {
          sendJson(request, response, config, 201, { data: pairingService.createChallenge() });
          return;
        }

        if (request.method === 'GET' && pairingStatusMatch) {
          sendJson(request, response, config, 200, {
            data: pairingService.statusForDesktop(pairingStatusMatch[1]!),
          });
          return;
        }

        if (request.method === 'POST' && pairingApproveMatch) {
          sendJson(request, response, config, 200, {
            data: pairingService.approve(pairingApproveMatch[1]!),
          });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/v1/config') {
          const publicConfig: AgentPublicConfig = {
            host: config.host,
            port: config.port,
            activityRetentionDays: config.activityRetentionDays,
            schemaVersion: activities.schemaVersion(),
            websocketPath: '/api/v1/events',
          };
          sendJson(request, response, config, 200, { data: publicConfig });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/v1/activities') {
          const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
          const limit = Number.isSafeInteger(requestedLimit) ? requestedLimit : 50;
          sendJson(request, response, config, 200, { data: activities.list(limit) });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/v1/activities') {
          const input = parseActivityInput(await readJson(request));
          const activity = activities.append(input);
          sendJson(request, response, config, 201, { data: activity });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/v1/ws-tickets') {
          sendJson(request, response, config, 201, { data: tickets.issue() });
          return;
        }

        throw new AgentError({
          code: 'ROUTE_NOT_FOUND',
          message: '要求されたAPIルートは存在しません。',
          status: 404,
          action: 'CHECK_REQUEST',
        });
      } catch (error) {
        const normalized = toErrorResponse(error, traceId);
        sendJson(request, response, config, normalized.status, normalized.body);
      }
    })();
  };
  const server = options.tls
    ? createHttpsServer(options.tls, requestHandler)
    : createHttpServer(requestHandler);

  eventHub.attach(server, tickets);
  server.once('close', () => {
    unsubscribe();
    eventHub.close();
    if (ownsStore) {
      activities.close();
    }
    if (ownsPairingService) {
      pairingService.close();
    }
  });
  return server;
}

export async function listen(server: Server, port = 47_831, host = '127.0.0.1'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
