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
import { ChangeService } from './change-service.js';
import { loadAgentConfig, type AgentConfig } from './config.js';
import { DeviceController, ScreenshotArtifactStore } from './device-controller.js';
import { AgentError, toErrorResponse } from './errors.js';
import { FixRequestService } from './fix-request-service.js';
import { PairingService, type PairingEndpoint } from './pairing-service.js';
import { PairingStore } from './pairing-store.js';
import { ProjectSessionService } from './project-session-service.js';
import { createM1ProbeReport } from './probes.js';
import { AgentEventHub } from './websocket.js';

export interface CreateAgentServerOptions {
  readonly config?: AgentConfig;
  readonly activityStore?: ActivityStore;
  readonly tls?: TlsServerOptions;
  readonly pairingEndpoint?: PairingEndpoint;
  readonly pairingService?: PairingService;
  readonly pairingTokenKey?: Buffer;
  readonly projectSessions?: ProjectSessionService;
  readonly screenshotArtifacts?: ScreenshotArtifactStore;
  readonly deviceController?: DeviceController;
  readonly fixRequests?: FixRequestService;
  readonly changes?: ChangeService;
  readonly preparePairing?: () => Promise<void>;
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

function sendPng(
  request: IncomingMessage,
  response: ServerResponse,
  config: AgentConfig,
  bytes: Buffer,
): void {
  const headers = jsonHeaders(request, config);
  response.writeHead(200, {
    ...headers,
    'content-type': 'image/png',
    'content-length': String(bytes.length),
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
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
  const ownsProjectSessions = options.projectSessions === undefined;
  const projectSessions = options.projectSessions ?? new ProjectSessionService(config.databasePath, activities);
  const ownsScreenshotArtifacts = options.screenshotArtifacts === undefined;
  const screenshotArtifacts = options.screenshotArtifacts ?? new ScreenshotArtifactStore();
  const deviceController =
    options.deviceController ??
    new DeviceController(projectSessions, screenshotArtifacts, activities);
  const ownsFixRequests = options.fixRequests === undefined;
  const fixRequests =
    options.fixRequests ??
    new FixRequestService(config.databasePath, activities, screenshotArtifacts, projectSessions);
  const ownsChanges = options.changes === undefined;
  const changes = options.changes ?? new ChangeService(config.databasePath, activities, fixRequests, projectSessions);
  const eventHub = new AgentEventHub();
  const unsubscribe = activities.subscribe((activity) => eventHub.publishActivity(activity));

  const collectDiagnostics = async () => {
    const session = projectSessions.getSession() ?? null;
    const devices = await projectSessions.devices();
    const authorizedDevices = devices.filter((device) => device.isAuthorized);
    let recovery: { action: string; title: string; message: string };
    if (!session) {
      recovery = {
        action: 'open_session',
        title: '開発セッションを開始してください',
        message: 'PC版でプロジェクトとAndroid端末を選び、Open Dev Sessionを押してください。',
      };
    } else if (session.state === 'running') {
      recovery = {
        action: 'none',
        title: '準備完了',
        message: 'AgentとFlutter開発セッションは実行中です。プレビューの更新やPoint & Fixを続けられます。',
      };
    } else if (session.state === 'starting') {
      recovery = {
        action: 'wait',
        title: 'Flutterを起動しています',
        message: 'アプリの起動が完了するまで待ってから、スマホ側で更新を押してください。',
      };
    } else {
      recovery = {
        action: 'restart_session',
        title: '開発セッションを再開してください',
        message: 'PC版でOpen Dev Sessionを押し、Flutterをもう一度起動してください。',
      };
    }
    return {
      agent: { status: 'ready', version: '0.3.0' },
      session,
      devices: {
        detected: devices.length,
        authorized: authorizedDevices.length,
        names: authorizedDevices.map((device) => device.name),
      },
      recovery,
    };
  };

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
        const projectPreflightMatch = /^\/api\/v1\/projects\/([^/]+)\/preflight$/.exec(url.pathname);
        const sessionStopMatch = /^\/api\/v1\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
        const mobileArtifactMatch = /^\/api\/v1\/mobile\/artifacts\/([^/]+)$/.exec(url.pathname);
        const mobileSessionScreenshotMatch = /^\/api\/v1\/mobile\/sessions\/([^/]+)\/screenshots$/.exec(url.pathname);
        const mobileFixRequestApproveMatch = /^\/api\/v1\/mobile\/fix-requests\/([^/]+)\/approve$/.exec(url.pathname);
        const mobileFixRequestProposalMatch = /^\/api\/v1\/mobile\/fix-requests\/([^/]+)\/proposals$/.exec(url.pathname);
        const mobileFixRequestChangeSetMatch = /^\/api\/v1\/mobile\/fix-requests\/([^/]+)\/change-set$/.exec(url.pathname);
        const mobileChangeSetMatch = /^\/api\/v1\/mobile\/change-sets\/([^/]+)$/.exec(url.pathname);
        const mobileChangeSetApplyMatch = /^\/api\/v1\/mobile\/change-sets\/([^/]+)\/apply$/.exec(url.pathname);
        const mobileChangeSetValidateMatch = /^\/api\/v1\/mobile\/change-sets\/([^/]+)\/validate$/.exec(url.pathname);
        const mobileChangeSetRevertMatch = /^\/api\/v1\/mobile\/change-sets\/([^/]+)\/revert$/.exec(url.pathname);
        const desktopChangeSetRevertMatch = /^\/api\/v1\/change-sets\/([^/]+)\/revert$/.exec(url.pathname);
        const desktopArtifactMatch = /^\/api\/v1\/artifacts\/([^/]+)$/.exec(url.pathname);

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

        const mobileProjects = request.method === 'GET' && url.pathname === '/api/v1/mobile/projects';
        const mobileDevices = request.method === 'GET' && url.pathname === '/api/v1/mobile/devices';
        const mobileSession = request.method === 'GET' && url.pathname === '/api/v1/mobile/session';
        const mobileDiagnostics = request.method === 'GET' && url.pathname === '/api/v1/mobile/diagnostics';
        const mobileStart = request.method === 'POST' && url.pathname === '/api/v1/mobile/sessions';
        const mobileStop = request.method === 'POST' && url.pathname === '/api/v1/mobile/session/stop';
        const mobileCapture = request.method === 'POST' && url.pathname === '/api/v1/mobile/previews';
        const mobileArtifact = request.method === 'GET' && mobileArtifactMatch !== null;
        const mobileSessionScreenshot = request.method === 'POST' && mobileSessionScreenshotMatch !== null;
        const mobileFixRequest = request.method === 'POST' && url.pathname === '/api/v1/mobile/fix-requests';
        const mobileFixRequestApprove = request.method === 'POST' && mobileFixRequestApproveMatch !== null;
        const mobileFixRequestProposal = request.method === 'POST' && mobileFixRequestProposalMatch !== null;
        const mobileFixRequestChangeSet = request.method === 'GET' && mobileFixRequestChangeSetMatch !== null;
        const mobileChangeSet = request.method === 'GET' && mobileChangeSetMatch !== null;
        const mobileChangeSetApply = request.method === 'POST' && mobileChangeSetApplyMatch !== null;
        const mobileChangeSetValidate = request.method === 'POST' && mobileChangeSetValidateMatch !== null;
        const mobileChangeSetRevert = request.method === 'POST' && mobileChangeSetRevertMatch !== null;
        if (mobileProjects || mobileDevices || mobileSession || mobileDiagnostics || mobileStart || mobileStop || mobileCapture || mobileArtifact || mobileSessionScreenshot || mobileFixRequest || mobileFixRequestApprove || mobileFixRequestProposal || mobileFixRequestChangeSet || mobileChangeSet || mobileChangeSetApply || mobileChangeSetValidate || mobileChangeSetRevert) {
          pairingService.authenticate(requireBearerToken(request.headers.authorization));
          if (mobileProjects) { sendJson(request, response, config, 200, { data: projectSessions.listProjects() }); return; }
          if (mobileDevices) { sendJson(request, response, config, 200, { data: await projectSessions.devices() }); return; }
          if (mobileSession) { sendJson(request, response, config, 200, { data: projectSessions.getSession() ?? null }); return; }
          if (mobileDiagnostics) { sendJson(request, response, config, 200, { data: await collectDiagnostics() }); return; }
          if (mobileStop) { const current = projectSessions.getSession(); if (!current) throw new AgentError({ code: 'REQUEST_INVALID', message: '終了する開発セッションがありません。', status: 400, action: 'CHECK_REQUEST' }); sendJson(request,response,config,200,{data:await projectSessions.stop(current.id)}); return; }
          if (mobileCapture) { sendJson(request, response, config, 201, { data: await deviceController.capturePreview() }); return; }
          if (mobileSessionScreenshot) { sendJson(request, response, config, 201, { data: await deviceController.capturePreview(mobileSessionScreenshotMatch![1]!) }); return; }
          if (mobileFixRequest) {
            const input = await readJson(request) as {
              sessionId?: unknown; screenshotId?: unknown; instruction?: unknown; annotation?: unknown;
              clientRequestId?: unknown; idempotencyKey?: unknown;
            };
            if (
              typeof input.sessionId !== 'string' || typeof input.screenshotId !== 'string' ||
              typeof input.instruction !== 'string' || typeof input.clientRequestId !== 'string' ||
              typeof input.idempotencyKey !== 'string' ||
              typeof input.annotation !== 'object' || input.annotation === null || Array.isArray(input.annotation)
            ) throw new AgentError({ code: 'REQUEST_INVALID', message: 'FixRequestの必須項目が不足しています。', status: 400, action: 'CHECK_REQUEST' });
            sendJson(request, response, config, 201, { data: fixRequests.create({
              sessionId: input.sessionId, screenshotId: input.screenshotId, instruction: input.instruction,
              annotation: input.annotation as never, clientRequestId: input.clientRequestId, idempotencyKey: input.idempotencyKey,
            }) });
            return;
          }
          if (mobileFixRequestApprove) { sendJson(request, response, config, 200, { data: fixRequests.approve(mobileFixRequestApproveMatch![1]!) }); return; }
          if (mobileFixRequestProposal) { sendJson(request, response, config, 201, { data: await changes.generate(mobileFixRequestProposalMatch![1]!) }); return; }
          if (mobileFixRequestChangeSet) { sendJson(request, response, config, 200, { data: changes.latestForFixRequest(mobileFixRequestChangeSetMatch![1]!) ?? null }); return; }
          if (mobileChangeSet) { sendJson(request, response, config, 200, { data: changes.get(mobileChangeSetMatch![1]!) }); return; }
          if (mobileChangeSetValidate) { sendJson(request, response, config, 200, { data: await changes.validate(mobileChangeSetValidateMatch![1]!) }); return; }
          if (mobileChangeSetApply) { sendJson(request, response, config, 200, { data: await changes.apply(mobileChangeSetApplyMatch![1]!) }); return; }
          if (mobileChangeSetRevert) { sendJson(request, response, config, 200, { data: changes.revert(mobileChangeSetRevertMatch![1]!) }); return; }
          if (mobileArtifact) {
            const artifact = screenshotArtifacts.read(mobileArtifactMatch![1]!);
            if (!artifact) throw new AgentError({ code: 'ARTIFACT_NOT_FOUND', message: 'プレビュー画像の有効期限が切れました。もう一度更新してください。', status: 404, action: 'RETRY', retryable: true });
            sendPng(request, response, config, artifact.bytes);
            return;
          }
          const input = await readJson(request) as { projectId?: unknown; deviceId?: unknown };
          if (typeof input.projectId !== 'string' || typeof input.deviceId !== 'string') throw new AgentError({ code: 'REQUEST_INVALID', message: 'projectId と deviceId が必要です。', status: 400, action: 'CHECK_REQUEST' });
          sendJson(request,response,config,201,{data:await projectSessions.start(input.projectId,input.deviceId)}); return;
        }

        const desktopPairingControl =
          (request.method === 'POST' && url.pathname === '/api/v1/pairings') ||
          (request.method === 'GET' && pairingStatusMatch !== null) ||
          (request.method === 'POST' && pairingApproveMatch !== null);
        const desktopProjectControl =
          url.pathname === '/api/v1/projects' ||
          projectPreflightMatch !== null ||
          url.pathname === '/api/v1/devices' ||
          url.pathname === '/api/v1/sessions' ||
          sessionStopMatch !== null ||
          url.pathname === '/api/v1/session' ||
          url.pathname === '/api/v1/diagnostics' ||
          url.pathname === '/api/v1/previews/capture' ||
          desktopArtifactMatch !== null ||
          desktopChangeSetRevertMatch !== null;
        if (
          url.pathname.startsWith('/api/v1/') &&
          !((desktopPairingControl || desktopProjectControl) && isLoopbackRequest(request))
        ) {
          requireDesktopToken(request.headers.authorization, config.desktopToken);
        }

        if (request.method === 'POST' && url.pathname === '/api/v1/pairings') {
          await options.preparePairing?.();
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

        if (desktopProjectControl && !isLoopbackRequest(request)) {
          requireDesktopToken(request.headers.authorization, config.desktopToken);
        }
        if (request.method === 'GET' && url.pathname === '/api/v1/projects') { sendJson(request,response,config,200,{data:projectSessions.listProjects()}); return; }
        if (request.method === 'POST' && url.pathname === '/api/v1/projects') { const input = await readJson(request) as { rootPath?: unknown }; if (typeof input.rootPath !== 'string') throw new AgentError({ code: 'REQUEST_INVALID', message: 'rootPath が必要です。', status: 400, action: 'CHECK_REQUEST' }); sendJson(request,response,config,201,{data:projectSessions.register(input.rootPath)}); return; }
        if (request.method === 'POST' && projectPreflightMatch) { sendJson(request,response,config,200,{data:await projectSessions.preflight(projectPreflightMatch[1]!)}); return; }
        if (request.method === 'GET' && url.pathname === '/api/v1/devices') { sendJson(request,response,config,200,{data:await projectSessions.devices()}); return; }
        if (request.method === 'GET' && url.pathname === '/api/v1/session') { sendJson(request,response,config,200,{data:projectSessions.getSession() ?? null}); return; }
        if (request.method === 'GET' && url.pathname === '/api/v1/diagnostics') { sendJson(request,response,config,200,{data:await collectDiagnostics()}); return; }
        if (request.method === 'POST' && url.pathname === '/api/v1/sessions') { const input = await readJson(request) as { projectId?: unknown; deviceId?: unknown }; if (typeof input.projectId !== 'string' || typeof input.deviceId !== 'string') throw new AgentError({ code: 'REQUEST_INVALID', message: 'projectId と deviceId が必要です。', status: 400, action: 'CHECK_REQUEST' }); sendJson(request,response,config,201,{data:await projectSessions.start(input.projectId,input.deviceId)}); return; }
        if (request.method === 'POST' && sessionStopMatch) { sendJson(request,response,config,200,{data:await projectSessions.stop(sessionStopMatch[1]!)}); return; }
        if (request.method === 'POST' && url.pathname === '/api/v1/previews/capture') { sendJson(request,response,config,201,{data:await deviceController.capturePreview()}); return; }
        if (request.method === 'POST' && desktopChangeSetRevertMatch) { sendJson(request,response,config,200,{data:changes.revert(desktopChangeSetRevertMatch[1]!)}); return; }
        if (request.method === 'GET' && desktopArtifactMatch) {
          const artifact = screenshotArtifacts.read(desktopArtifactMatch[1]!);
          if (!artifact) throw new AgentError({ code: 'ARTIFACT_NOT_FOUND', message: 'プレビュー画像の有効期限が切れました。もう一度更新してください。', status: 404, action: 'RETRY', retryable: true });
          sendPng(request, response, config, artifact.bytes);
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
    if (ownsProjectSessions) {
      projectSessions.close();
    }
    if (ownsScreenshotArtifacts) {
      screenshotArtifacts.clear();
    }
    if (ownsFixRequests) {
      fixRequests.close();
    }
    if (ownsChanges) {
      changes.close();
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
