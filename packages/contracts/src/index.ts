export const protocolVersion = 1 as const;

export type AgentHealthStatus = 'ready' | 'starting' | 'degraded';

export interface AgentHealth {
  readonly name: 'devpilot-agent';
  readonly version: string;
  readonly protocolVersion: typeof protocolVersion;
  readonly status: AgentHealthStatus;
  readonly occurredAt: string;
}

export function createAgentHealth(
  version: string,
  status: AgentHealthStatus = 'ready',
): AgentHealth {
  return {
    name: 'devpilot-agent',
    version,
    protocolVersion,
    status,
    occurredAt: new Date().toISOString(),
  };
}

export const deviceCapabilities = [
  'deviceList',
  'runApp',
  'screenshot',
  'hotReload',
  'widgetTree',
  'runtimeErrors',
  'tap',
  'textInput',
  'scroll',
] as const;

export type DeviceCapability = (typeof deviceCapabilities)[number];

export const adapterIds = ['flutter-mcp', 'flutter-cli', 'vm-service', 'adb'] as const;

export type AdapterId = (typeof adapterIds)[number];

export type ProbeStatus = 'available' | 'unavailable' | 'degraded';

export interface AdapterProbe {
  readonly adapterId: AdapterId;
  readonly status: ProbeStatus;
  readonly capabilities: readonly DeviceCapability[];
  readonly measuredAt: string;
  readonly latencyMs?: number;
  readonly details: readonly string[];
}

export interface TlsProbe {
  readonly status: ProbeStatus;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly fingerprint256: string;
  readonly latencyMs: number;
  readonly expiresAt: string;
  readonly details: readonly string[];
}

export interface M1ProbeReport {
  readonly generatedAt: string;
  readonly platform: string;
  readonly adapters: readonly AdapterProbe[];
  readonly tls: TlsProbe;
  readonly notes: readonly string[];
}

export const activityKinds = [
  'agent.started',
  'agent.stopped',
  'config.loaded',
  'storage.migrated',
  'pairing.created',
  'pairing.confirmed',
  'pairing.approved',
  'pairing.revoked',
  'project.registered',
  'session.started',
  'session.stopped',
  'screenshot.captured',
  'fix_request.created',
  'fix_request.approved',
  'job.updated',
  'user.note',
] as const;

export type ActivityKind = (typeof activityKinds)[number];
export type ActivitySeverity = 'info' | 'success' | 'warning' | 'error';

export interface ActivityRecord {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly severity: ActivitySeverity;
  readonly message: string;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CreateActivityInput {
  readonly kind: ActivityKind;
  readonly severity?: ActivitySeverity;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export const devPilotErrorCodes = [
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'AUTH_TICKET_INVALID',
  'AUTH_TOKEN_EXPIRED',
  'PAIRING_INVALID',
  'PAIRING_EXPIRED',
  'PAIRING_REPLAYED',
  'PAIRING_PENDING',
  'PAIRING_DENIED',
  'REQUEST_INVALID',
  'CAPTURE_FAILED',
  'ARTIFACT_NOT_FOUND',
  'FIX_REQUEST_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'STORAGE_FAILURE',
  'INTERNAL_ERROR',
] as const;

export type DevPilotErrorCode = (typeof devPilotErrorCodes)[number];
export type DevPilotErrorAction =
  'REAUTHENTICATE' | 'RETRY' | 'CHECK_REQUEST' | 'OPEN_DETAILS' | 'NONE';

export interface DevPilotErrorBody {
  readonly code: DevPilotErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly action: DevPilotErrorAction;
  readonly traceId: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ErrorEnvelope {
  readonly error: DevPilotErrorBody;
}

export interface DataEnvelope<T> {
  readonly data: T;
}

export interface AgentPublicConfig {
  readonly host: string;
  readonly port: number;
  readonly activityRetentionDays: number;
  readonly schemaVersion: number;
  readonly websocketPath: '/api/v1/events';
}

export interface PairingQrPayload {
  readonly scheme: 'devpilot';
  readonly version: typeof protocolVersion;
  readonly pairingId: string;
  readonly hostCandidates: readonly string[];
  readonly port: number;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly serverPublicKeyFingerprint: string;
}

export type PairingStatus =
  'awaiting_confirmation' | 'awaiting_approval' | 'approved' | 'denied' | 'expired' | 'revoked';

export interface PairingChallenge {
  readonly id: string;
  readonly status: PairingStatus;
  readonly qrPayload: PairingQrPayload;
  readonly expiresAt: string;
}

export interface PairingPendingDevice {
  readonly displayName: string;
  readonly publicKey: string;
}

export interface PairingState {
  readonly id: string;
  readonly status: PairingStatus;
  readonly expiresAt: string;
  readonly device?: PairingPendingDevice;
}

export interface DeviceTokens {
  readonly deviceId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

export type ProjectStatus = 'ready' | 'action_required';
export interface RegisteredProject {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface AndroidDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly isAuthorized: boolean;
}
export interface SessionPreflight {
  readonly projectId: string;
  readonly isFlutterProject: boolean;
  readonly flutterAvailable: boolean;
  readonly devices: readonly AndroidDevice[];
  readonly gitState: 'clean' | 'dirty' | 'unavailable';
  readonly issues: readonly string[];
}
export type DevSessionState = 'starting' | 'running' | 'stopped' | 'failed';
export interface DevSession {
  readonly id: string;
  readonly projectId: string;
  readonly deviceId: string;
  readonly state: DevSessionState;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly detail?: string;
}

export interface ScreenshotArtifact {
  readonly id: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly adapterId: AdapterId;
  readonly mimeType: 'image/png';
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
}

export type FixAnnotation =
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'rectangle';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export type FixRequestState = 'awaiting_approval' | 'approved' | 'cancelled';

export interface FixRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly screenshotId: string;
  readonly instruction: string;
  readonly annotation: FixAnnotation;
  readonly requestedCapabilities: readonly ('edit_existing_dart' | 'hot_reload')[];
  readonly clientRequestId: string;
  readonly idempotencyKey: string;
  readonly state: FixRequestState;
  readonly createdAt: string;
  readonly approvedAt?: string;
}

export interface WsTicket {
  readonly ticket: string;
  readonly expiresAt: string;
}

export interface AgentEventEnvelope<T = unknown> {
  readonly protocolVersion: typeof protocolVersion;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly traceId: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly sequence: number;
  readonly payload: T;
}
