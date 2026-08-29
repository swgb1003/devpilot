import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export interface AgentConfig {
  readonly host: '127.0.0.1' | '0.0.0.0';
  readonly port: number;
  readonly pairingPort: number;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly activityRetentionDays: number;
  readonly desktopToken: string;
  readonly allowedOrigins: readonly string[];
  readonly tlsCertificatePath?: string;
  readonly tlsKeyPath?: string;
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AgentConfig {
  const configuredHost = environment.DEVPILOT_AGENT_HOST ?? '127.0.0.1';
  if (configuredHost !== '127.0.0.1') {
    throw new Error('M2 only permits the Agent API to bind to 127.0.0.1.');
  }

  const port = parseInteger(environment.DEVPILOT_AGENT_PORT, 47_831, 'DEVPILOT_AGENT_PORT');
  if (port < 1 || port > 65_535) {
    throw new Error('DEVPILOT_AGENT_PORT must be between 1 and 65535.');
  }

  const pairingPort = parseInteger(
    environment.DEVPILOT_PAIRING_PORT,
    47_832,
    'DEVPILOT_PAIRING_PORT',
  );
  if (pairingPort < 1 || pairingPort > 65_535 || pairingPort === port) {
    throw new Error(
      'DEVPILOT_PAIRING_PORT must be a valid port different from DEVPILOT_AGENT_PORT.',
    );
  }

  const activityRetentionDays = parseInteger(
    environment.DEVPILOT_ACTIVITY_RETENTION_DAYS,
    30,
    'DEVPILOT_ACTIVITY_RETENTION_DAYS',
  );
  if (activityRetentionDays < 1 || activityRetentionDays > 365) {
    throw new Error('DEVPILOT_ACTIVITY_RETENTION_DAYS must be between 1 and 365.');
  }

  const configuredDataDirectory = environment.DEVPILOT_DATA_DIR ?? '.devpilot-data';
  const dataDirectory = isAbsolute(configuredDataDirectory)
    ? configuredDataDirectory
    : resolve(workingDirectory, configuredDataDirectory);
  const desktopToken = environment.DEVPILOT_DESKTOP_TOKEN ?? randomBytes(32).toString('base64url');
  if (desktopToken.length < 32) {
    throw new Error('DEVPILOT_DESKTOP_TOKEN must contain at least 32 characters.');
  }
  const tlsCertificatePath = environment.DEVPILOT_TLS_CERT_PATH;
  const tlsKeyPath = environment.DEVPILOT_TLS_KEY_PATH;
  if ((tlsCertificatePath === undefined) !== (tlsKeyPath === undefined)) {
    throw new Error(
      'DEVPILOT_TLS_CERT_PATH and DEVPILOT_TLS_KEY_PATH must be configured together.',
    );
  }

  return {
    host: configuredHost,
    port,
    pairingPort,
    dataDirectory,
    databasePath: join(dataDirectory, 'devpilot.sqlite3'),
    activityRetentionDays,
    desktopToken,
    allowedOrigins: [
      `http://127.0.0.1:${port}`,
      'http://127.0.0.1:5173',
      'tauri://localhost',
      'https://tauri.localhost',
    ],
    ...(tlsCertificatePath && tlsKeyPath
      ? {
          tlsCertificatePath: isAbsolute(tlsCertificatePath)
            ? tlsCertificatePath
            : resolve(workingDirectory, tlsCertificatePath),
          tlsKeyPath: isAbsolute(tlsKeyPath) ? tlsKeyPath : resolve(workingDirectory, tlsKeyPath),
        }
      : {}),
  };
}
