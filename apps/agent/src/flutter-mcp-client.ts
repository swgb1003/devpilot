import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FlutterMcpScreenshotClient } from './device-controller.js';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const defaultRequestTimeoutMs = 3_000;
const maxProtocolLineBytes = 4 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface FlutterMcpStdioOptions {
  readonly executable?: string;
  readonly arguments?: readonly string[];
  readonly requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveDartExecutable(): string {
  const configured = process.env.DEVPILOT_DART_COMMAND;
  if (configured && (configured === 'dart' || existsSync(configured))) return configured;

  const flutterRoot = process.env.FLUTTER_ROOT;
  if (flutterRoot) {
    const bundled = join(flutterRoot, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
    if (existsSync(bundled)) return bundled;
  }

  const flutterCommand = process.env.DEVPILOT_FLUTTER_COMMAND;
  if (flutterCommand && existsSync(flutterCommand)) {
    const bundled = join(dirname(flutterCommand), 'cache', 'dart-sdk', 'bin', 'dart.exe');
    if (existsSync(bundled)) return bundled;
  }

  return process.platform === 'win32' ? 'dart.exe' : 'dart';
}

function responseId(value: unknown): number | undefined {
  return isRecord(value) && typeof value.id === 'number' ? value.id : undefined;
}

function toolContent(result: unknown): readonly JsonRecord[] {
  if (!isRecord(result) || !Array.isArray(result.content)) return [];
  return result.content.filter(isRecord);
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function collectUris(value: unknown, keyNames: readonly string[] = ['uri', 'appUri']): string[] {
  const found = new Set<string>();
  const visit = (candidate: unknown): void => {
    const parsed = parseEmbeddedJson(candidate);
    if (typeof parsed === 'string') {
      if (/^(?:https?|wss?):\/\//.test(parsed)) found.add(parsed);
    } else if (isRecord(parsed)) {
      for (const [key, child] of Object.entries(parsed)) {
        if (
          keyNames.includes(key) &&
          typeof child === 'string' &&
          /^(?:https?|wss?):\/\//.test(child)
        ) {
          found.add(child);
        }
        visit(child);
      }
    } else if (Array.isArray(parsed)) {
      for (const child of parsed) visit(child);
    }
  };
  visit(value);
  return [...found];
}

function findAppUri(value: unknown, deviceId: string): string | undefined {
  const matching: string[] = [];
  const visit = (candidate: unknown): void => {
    const parsed = parseEmbeddedJson(candidate);
    if (isRecord(parsed)) {
      const appUri =
        typeof parsed.appUri === 'string'
          ? parsed.appUri
          : typeof parsed.uri === 'string'
            ? parsed.uri
            : undefined;
      if (
        appUri &&
        /^(?:https?|wss?):\/\//.test(appUri) &&
        JSON.stringify(parsed).includes(deviceId)
      ) {
        matching.push(appUri);
      }
      for (const child of Object.values(parsed)) visit(child);
    } else if (Array.isArray(parsed)) {
      for (const child of parsed) visit(child);
    }
  };
  visit(value);
  return matching[0] ?? collectUris(value)[0];
}

function readPng(result: unknown): Buffer | undefined {
  for (const content of toolContent(result)) {
    if (
      content.type !== 'image' ||
      content.mimeType !== 'image/png' ||
      typeof content.data !== 'string'
    ) {
      continue;
    }
    const bytes = Buffer.from(content.data, 'base64');
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(pngSignature)) return bytes;
  }
  return undefined;
}

class McpStdioTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  readonly #requestTimeoutMs: number;
  #nextId = 1;
  #stdout = Buffer.alloc(0);
  #closed = false;

  constructor(executable: string, arguments_: readonly string[], requestTimeoutMs: number) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#child = spawn(executable, arguments_, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child.stdout.on('data', (chunk: Buffer) => this.#read(chunk));
    this.#child.once('error', (error) => this.#fail(error));
    this.#child.once('exit', () => this.#fail(new Error('Flutter MCP server exited.')));
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'devpilot-agent', version: '0.1.0' },
    });
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  }

  request(method: string, params: JsonRecord): Promise<unknown> {
    if (this.#closed || !this.#child.stdin.writable) {
      return Promise.reject(new Error('Flutter MCP transport is unavailable.'));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Flutter MCP ${method} timed out.`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.#pending.delete(id);
          pending.reject(error);
        },
      );
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill();
    this.#fail(new Error('Flutter MCP transport closed.'));
  }

  #read(chunk: Buffer): void {
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    if (this.#stdout.length > maxProtocolLineBytes) {
      this.close();
      return;
    }
    let newline = this.#stdout.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#stdout.subarray(0, newline).toString('utf8').trim();
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (line) this.#handleLine(line);
      newline = this.#stdout.indexOf(0x0a);
    }
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const id = responseId(message);
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(id);
    if (isRecord(message) && 'error' in message) {
      pending.reject(new Error('Flutter MCP returned an error.'));
      return;
    }
    pending.resolve(isRecord(message) ? message.result : undefined);
  }

  #fail(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

/**
 * A short-lived Flutter MCP session. It discovers a Dart Tooling Daemon,
 * selects the app belonging to the requested device, and asks its Driver
 * extension for a PNG. Any transport, discovery, or image error returns
 * undefined so the independent ADB adapter can safely take over.
 */
export class FlutterMcpStdioScreenshotClient implements FlutterMcpScreenshotClient {
  readonly #executable: string;
  readonly #arguments: readonly string[];
  readonly #requestTimeoutMs: number;

  constructor(options: FlutterMcpStdioOptions = {}) {
    this.#executable = options.executable ?? resolveDartExecutable();
    this.#arguments = options.arguments ?? ['mcp-server'];
    this.#requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  }

  async captureScreenshot(deviceId: string): Promise<Buffer | undefined> {
    const transport = new McpStdioTransport(
      this.#executable,
      this.#arguments,
      this.#requestTimeoutMs,
    );
    try {
      await transport.initialize();
      const dtds = await transport.request('tools/call', {
        name: 'dtd',
        arguments: { command: 'listDtdUris' },
      });
      const dtdUri = collectUris(toolContent(dtds))[0];
      if (!dtdUri) return undefined;

      await transport.request('tools/call', {
        name: 'dtd',
        arguments: { command: 'connect', uri: dtdUri },
      });
      const connectedApps = await transport.request('tools/call', {
        name: 'dtd',
        arguments: { command: 'listConnectedApps' },
      });
      const appUri = findAppUri(toolContent(connectedApps), deviceId);
      if (!appUri) return undefined;

      const screenshot = await transport.request('tools/call', {
        name: 'flutter_driver_command',
        arguments: { command: 'screenshot', appUri },
      });
      return readPng(screenshot);
    } catch {
      return undefined;
    } finally {
      transport.close();
    }
  }
}
