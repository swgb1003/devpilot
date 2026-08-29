import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import type { AdapterProbe, M1ProbeReport, ProbeStatus } from '@devpilot/contracts';

import { runBinaryCommand, runCommand, type CommandResult } from './command.js';
import { runLocalTlsProbe } from './tls-probe.js';

const commandTimeoutMs = 8_000;
const mcpProbeTimeoutMs = 1_500;

interface ResolvedCommand {
  readonly environment?: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly prefixArguments: readonly string[];
  readonly root?: string;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function findOnPath(command: string): Promise<string | undefined> {
  const path = process.env.PATH ?? '';
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  return firstExisting(
    path
      .split(delimiter)
      .filter(Boolean)
      .flatMap((entry) => suffixes.map((suffix) => join(entry, `${command}${suffix}`))),
  );
}

async function resolveFlutter(): Promise<ResolvedCommand | undefined> {
  const flutterBinary =
    (process.env.DEVPILOT_FLUTTER_BIN
      ? await firstExisting([process.env.DEVPILOT_FLUTTER_BIN])
      : undefined) ??
    (process.env.FLUTTER_ROOT
      ? await firstExisting([join(process.env.FLUTTER_ROOT, 'bin', 'flutter.bat')])
      : undefined) ??
    (await findOnPath('flutter'));
  const flutterRoot =
    process.env.FLUTTER_ROOT ?? (flutterBinary ? dirname(dirname(flutterBinary)) : undefined);

  if (flutterRoot) {
    const dart = join(flutterRoot, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
    const flutterToolsSnapshot = join(flutterRoot, 'bin', 'cache', 'flutter_tools.snapshot');
    if ((await isExecutable(dart)) && (await isExecutable(flutterToolsSnapshot))) {
      return {
        environment: {
          ...process.env,
          CI: 'true',
          FLUTTER_ALREADY_LOCKED: 'true',
          FLUTTER_ROOT: flutterRoot,
          FLUTTER_SUPPRESS_ANALYTICS: 'true',
        },
        executable: dart,
        prefixArguments: [flutterToolsSnapshot],
        root: flutterRoot,
      };
    }
  }

  return flutterBinary
    ? {
        executable: flutterBinary,
        prefixArguments: [],
        ...(flutterRoot ? { root: flutterRoot } : {}),
      }
    : undefined;
}

async function resolveDart(): Promise<string | undefined> {
  const flutter = await resolveFlutter();

  return (
    (process.env.DEVPILOT_DART_BIN
      ? await firstExisting([process.env.DEVPILOT_DART_BIN])
      : undefined) ??
    (process.env.FLUTTER_ROOT
      ? await firstExisting([
          join(process.env.FLUTTER_ROOT, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe'),
        ])
      : undefined) ??
    (flutter?.root
      ? await firstExisting([join(flutter.root, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe')])
      : undefined) ??
    (await findOnPath('dart'))
  );
}

async function resolveAdb(): Promise<string | undefined> {
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const localAppData = process.env.LOCALAPPDATA;

  return (
    (process.env.DEVPILOT_ADB_BIN
      ? await firstExisting([process.env.DEVPILOT_ADB_BIN])
      : undefined) ??
    (androidHome
      ? await firstExisting([join(androidHome, 'platform-tools', 'adb.exe')])
      : undefined) ??
    (localAppData
      ? await firstExisting([join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe')])
      : undefined) ??
    (await findOnPath('adb'))
  );
}

function resultDetails(result: CommandResult, timeoutMs = commandTimeoutMs): string[] {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const detail = output ? output.split(/\r?\n/).find(Boolean) : undefined;
  const values = [
    `${result.executable} ${result.arguments.join(' ')} completed in ${result.durationMs}ms.`,
  ];

  if (result.timedOut) {
    values.push(`Timed out after ${timeoutMs}ms.`);
  }
  if (result.exitCode !== 0) {
    values.push(`Exit code: ${result.exitCode ?? 'not started'}.`);
  }
  if (detail) {
    values.push(detail.slice(0, 300));
  }

  return values;
}

function resultStatus(result: CommandResult): ProbeStatus {
  return result.exitCode === 0 && !result.timedOut ? 'available' : 'unavailable';
}

export async function probeFlutterCli(): Promise<AdapterProbe> {
  const measuredAt = new Date().toISOString();
  const flutter = await resolveFlutter();

  if (!flutter) {
    return {
      adapterId: 'flutter-cli',
      status: 'unavailable',
      capabilities: [],
      measuredAt,
      details: ['Flutter CLI was not found. Set DEVPILOT_FLUTTER_BIN or add Flutter to PATH.'],
    };
  }

  const version = await runCommand(
    flutter.executable,
    [...flutter.prefixArguments, '--version'],
    commandTimeoutMs,
    flutter.environment ? { environment: flutter.environment } : {},
  );
  const status = resultStatus(version);
  const details = resultDetails(version);

  if (status === 'available') {
    const devices = await runCommand(
      flutter.executable,
      [...flutter.prefixArguments, 'devices', '--machine'],
      commandTimeoutMs,
      flutter.environment ? { environment: flutter.environment } : {},
    );
    details.push(...resultDetails(devices));
  }

  return {
    adapterId: 'flutter-cli',
    status,
    capabilities: status === 'available' ? ['deviceList', 'runApp', 'hotReload'] : [],
    measuredAt,
    latencyMs: version.durationMs,
    details,
  };
}

export async function probeFlutterMcp(): Promise<AdapterProbe> {
  const measuredAt = new Date().toISOString();
  const dart = await resolveDart();

  if (!dart) {
    return {
      adapterId: 'flutter-mcp',
      status: 'unavailable',
      capabilities: [],
      measuredAt,
      details: ['Dart SDK was not found. Flutter MCP requires Dart 3.9 or later.'],
    };
  }

  const command = await runCommand(dart, ['mcp-server', '--help'], mcpProbeTimeoutMs);
  const commandStatus = resultStatus(command);
  const serverAcceptedStdio =
    command.timedOut && command.exitCode === null && command.stderr.trim().length === 0;
  const mcpAvailable = commandStatus === 'available' || serverAcceptedStdio;

  return {
    adapterId: 'flutter-mcp',
    status: mcpAvailable ? 'degraded' : 'unavailable',
    capabilities: mcpAvailable
      ? ['screenshot', 'hotReload', 'widgetTree', 'runtimeErrors', 'tap', 'textInput', 'scroll']
      : [],
    measuredAt,
    latencyMs: command.durationMs,
    details: [
      ...resultDetails(command, mcpProbeTimeoutMs),
      serverAcceptedStdio
        ? 'The MCP server accepted the stdio command and awaits a JSON-RPC handshake.'
        : 'An authorized running Flutter debug app is required for a full tool handshake.',
    ],
  };
}

export async function probeAdb(): Promise<AdapterProbe> {
  const measuredAt = new Date().toISOString();
  const adb = await resolveAdb();

  if (!adb) {
    return {
      adapterId: 'adb',
      status: 'unavailable',
      capabilities: [],
      measuredAt,
      details: ['ADB was not found. Set DEVPILOT_ADB_BIN or install Android platform-tools.'],
    };
  }

  const devices = await runCommand(adb, ['devices', '-l'], commandTimeoutMs);
  const authorizedDevice = devices.stdout
    .split(/\r?\n/)
    .some((line) => /^\S+\s+device(?:\s|$)/.test(line.trim()));
  const screenshot = authorizedDevice
    ? await runBinaryCommand(adb, ['exec-out', 'screencap', '-p'], commandTimeoutMs)
    : undefined;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngOffset = screenshot ? screenshot.stdout.indexOf(pngSignature) : -1;
  const screenshotIsPng =
    screenshot !== undefined &&
    !screenshot.timedOut &&
    screenshot.exitCode === 0 &&
    !screenshot.truncated &&
    pngOffset >= 0 &&
    screenshot.stdout.length >= pngOffset + 24;
  const screenshotWidth = screenshotIsPng
    ? screenshot!.stdout.readUInt32BE(pngOffset + 16)
    : undefined;
  const screenshotHeight = screenshotIsPng
    ? screenshot!.stdout.readUInt32BE(pngOffset + 20)
    : undefined;
  const screenshotBytes = screenshotIsPng ? screenshot!.stdout.length - pngOffset : undefined;
  const status = resultStatus(devices)
    ? authorizedDevice && screenshotIsPng
      ? 'available'
      : 'degraded'
    : 'unavailable';

  return {
    adapterId: 'adb',
    status,
    capabilities:
      status === 'available'
        ? ['deviceList', 'screenshot']
        : status === 'degraded'
          ? ['deviceList']
          : [],
    measuredAt,
    latencyMs: devices.durationMs,
    details: [
      ...resultDetails(devices),
      ...(screenshot
        ? [
            screenshotIsPng
              ? `PNG screenshot verified (${screenshotWidth}x${screenshotHeight}, ${screenshotBytes} bytes) in ${screenshot.durationMs}ms. Image data is not stored or returned.`
              : `ADB screenshot verification failed after ${screenshot.durationMs}ms (exit ${screenshot.exitCode ?? 'not started'}, timed out: ${screenshot.timedOut}, truncated: ${screenshot.truncated}).`,
          ]
        : []),
      authorizedDevice
        ? screenshotIsPng
          ? 'An authorized Android device is available and screenshot capability is measured.'
          : 'An authorized Android device is available, but screenshot measurement did not pass.'
        : 'No authorized Android device is connected; ADB screenshot measurement is pending.',
    ],
  };
}

export async function createM1ProbeReport(): Promise<M1ProbeReport> {
  const [flutterMcp, flutterCli, adb, tls] = await Promise.all([
    probeFlutterMcp(),
    probeFlutterCli(),
    probeAdb(),
    runLocalTlsProbe(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    adapters: [flutterMcp, flutterCli, adb],
    tls,
    notes: [
      'M1 records tool availability separately from a real-device capability handshake.',
      'M2 will persist pairing trust and replace this ephemeral TLS probe with a managed certificate lifecycle.',
    ],
  };
}
