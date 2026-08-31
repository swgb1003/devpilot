import { existsSync } from 'node:fs';

import { runCommand } from './command.js';

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

/**
 * Makes a USB-connected Android device's loopback port reach the local Agent.
 * It is intentionally best-effort: LAN pairing must remain available if ADB is
 * not installed or no authorized device is connected.
 */
export async function configureUsbPairingReverse(port: number): Promise<readonly string[]> {
  const adb = resolveAdbExecutable();
  const devices = await runCommand(adb, ['devices'], 8_000);
  if (devices.exitCode !== 0 || devices.timedOut) return [];
  const ids = devices.stdout
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const match = /^(\S+)\s+device\b/.exec(line.trim());
      return match ? [match[1]!] : [];
    });
  const configured = await Promise.all(
    ids.map(async (id) => {
      const result = await runCommand(
        adb,
        ['-s', id, 'reverse', `tcp:${port}`, `tcp:${port}`],
        8_000,
      );
      return result.exitCode === 0 && !result.timedOut ? id : undefined;
    }),
  );
  return configured.filter((id): id is string => id !== undefined);
}
