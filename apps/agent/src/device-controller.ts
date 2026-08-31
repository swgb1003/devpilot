import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import type { AdapterId, ScreenshotArtifact } from '@devpilot/contracts';

import { ActivityStore } from './activity-store.js';
import { runBinaryCommand } from './command.js';
import { AgentError } from './errors.js';
import { ProjectSessionService } from './project-session-service.js';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const previewTtlMs = 5 * 60_000;

interface CapturedPng {
  readonly adapterId: AdapterId;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/** The minimal boundary needed to connect the Flutter MCP transport. */
export interface FlutterMcpScreenshotClient {
  captureScreenshot(deviceId: string): Promise<Buffer | undefined>;
}

interface ScreenshotAdapter {
  readonly id: AdapterId;
  capture(deviceId: string): Promise<CapturedPng | undefined>;
}

interface StoredArtifact {
  readonly metadata: ScreenshotArtifact;
  readonly bytes: Buffer;
}

function resolveAdbExecutable(): string {
  const configured = process.env.DEVPILOT_ADB_COMMAND;
  if (configured && (configured === 'adb' || existsSync(configured))) {
    return configured;
  }
  const windowsSdk = `${process.env.LOCALAPPDATA ?? ''}\\Android\\Sdk\\platform-tools\\adb.exe`;
  if (process.platform === 'win32' && existsSync(windowsSdk)) {
    return windowsSdk;
  }
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function invalidScreenshot(message: string, retryable = false): AgentError {
  return new AgentError({
    code: 'CAPTURE_FAILED',
    message,
    status: 503,
    retryable,
    action: retryable ? 'RETRY' : 'CHECK_REQUEST',
  });
}

function inspectPng(bytes: Buffer): { readonly width: number; readonly height: number } {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw invalidScreenshot('端末から有効なPNGスクリーンショットを取得できませんでした。', true);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 10_000 || height > 10_000) {
    throw invalidScreenshot('取得したスクリーンショットのサイズが正しくありません。', true);
  }
  return { width, height };
}

function extractPng(bytes: Buffer): Buffer {
  const offset = bytes.indexOf(pngSignature);
  // Some Android builds print a short display-selection warning before the
  // binary payload of `screencap -p`.  Accept only a small textual prelude;
  // this prevents treating arbitrary command output as an image.
  if (offset > 0 && offset <= 1_024) {
    return bytes.subarray(offset);
  }
  return bytes;
}

class FlutterMcpScreenshotAdapter implements ScreenshotAdapter {
  readonly id = 'flutter-mcp' as const;

  constructor(private readonly client?: FlutterMcpScreenshotClient) {}

  async capture(deviceId: string): Promise<CapturedPng | undefined> {
    const bytes = await this.client?.captureScreenshot(deviceId);
    if (!bytes) return undefined;
    const png = extractPng(bytes);
    return { adapterId: this.id, bytes: png, ...inspectPng(png) };
  }
}

class AdbScreenshotAdapter implements ScreenshotAdapter {
  readonly id = 'adb' as const;
  readonly #executable = resolveAdbExecutable();

  async capture(deviceId: string): Promise<CapturedPng> {
    const result = await runBinaryCommand(
      this.#executable,
      ['-s', deviceId, 'exec-out', 'screencap', '-p'],
      10_000,
    );
    if (result.timedOut) {
      throw invalidScreenshot('スクリーンショットの取得がタイムアウトしました。端末の接続を確認して再試行してください。', true);
    }
    if (result.truncated || result.exitCode !== 0) {
      const detail = result.stderr.trim().replaceAll(/\s+/g, ' ').slice(0, 180);
      throw invalidScreenshot(
        `Android端末からスクリーンショットを取得できませんでした。${detail ? ` ${detail}` : ''}`,
        true,
      );
    }
    const png = extractPng(result.stdout);
    const dimensions = inspectPng(png);
    return { adapterId: this.id, bytes: png, ...dimensions };
  }
}

/**
 * Keeps preview bytes in memory only.  A fresh capture replaces no user data,
 * and expired artifacts cannot be read back from an API endpoint.
 */
export class ScreenshotArtifactStore {
  readonly #artifacts = new Map<string, StoredArtifact>();

  save(input: {
    readonly sessionId: string;
    readonly deviceId: string;
    readonly capture: CapturedPng;
  }): ScreenshotArtifact {
    this.purgeExpired();
    const capturedAt = new Date();
    const metadata: ScreenshotArtifact = {
      id: randomUUID(),
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      adapterId: input.capture.adapterId,
      mimeType: 'image/png',
      bytes: input.capture.bytes.length,
      width: input.capture.width,
      height: input.capture.height,
      sha256: createHash('sha256').update(input.capture.bytes).digest('hex'),
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + previewTtlMs).toISOString(),
    };
    this.#artifacts.set(metadata.id, { metadata, bytes: input.capture.bytes });
    return metadata;
  }

  read(id: string): StoredArtifact | undefined {
    this.purgeExpired();
    return this.#artifacts.get(id);
  }

  metadata(id: string): ScreenshotArtifact | undefined {
    return this.read(id)?.metadata;
  }

  clear(): void {
    this.#artifacts.clear();
  }

  private purgeExpired(now = Date.now()): void {
    for (const [id, artifact] of this.#artifacts) {
      if (Date.parse(artifact.metadata.expiresAt) <= now) {
        this.#artifacts.delete(id);
      }
    }
  }
}

/**
 * Product-facing controller.  Flutter MCP can be added as a preferred adapter
 * later without changing the route or mobile contract; M5 uses ADB as the
 * verified fallback for the screenshot capability.
 */
export class DeviceController {
  readonly #adb = new AdbScreenshotAdapter();

  constructor(
    private readonly projectSessions: ProjectSessionService,
    private readonly artifacts: ScreenshotArtifactStore,
    private readonly activities: ActivityStore,
    flutterMcp?: FlutterMcpScreenshotClient,
  ) {
    this.#mcp = new FlutterMcpScreenshotAdapter(flutterMcp);
  }

  readonly #mcp: FlutterMcpScreenshotAdapter;

  async capturePreview(expectedSessionId?: string): Promise<ScreenshotArtifact> {
    const session = this.projectSessions.getSession();
    if (!session || session.state !== 'running') {
      throw new AgentError({
        code: 'REQUEST_INVALID',
        message: '実行中のFlutter開発セッションがありません。PCで開発セッションを開始してから再試行してください。',
        status: 409,
        action: 'CHECK_REQUEST',
      });
    }
    if (expectedSessionId && expectedSessionId !== session.id) {
      throw new AgentError({
        code: 'REQUEST_INVALID',
        message: '指定された開発セッションは現在実行中ではありません。画面を更新してから再試行してください。',
        status: 409,
        action: 'CHECK_REQUEST',
      });
    }
    // Prefer Flutter MCP when a transport is registered; in the M5 desktop
    // slice no MCP transport is available yet, so verified ADB is selected.
    const capture =
      (await this.#mcp.capture(session.deviceId)) ??
      (await this.#adb.capture(session.deviceId));
    const artifact = this.artifacts.save({
      sessionId: session.id,
      deviceId: session.deviceId,
      capture,
    });
    this.activities.append({
      kind: 'screenshot.captured',
      severity: 'success',
      message: 'Live Preview用のスクリーンショットを取得しました。',
      metadata: {
        artifactId: artifact.id,
        sessionId: artifact.sessionId,
        deviceId: artifact.deviceId,
        adapterId: artifact.adapterId,
        width: artifact.width,
        height: artifact.height,
      },
    });
    return artifact;
  }
}
