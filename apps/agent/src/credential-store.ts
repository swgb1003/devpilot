import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const secretFileName = 'pairing-token-key.bin';

/**
 * Keeps the symmetric key outside SQLite. On Windows the DevPilot data folder
 * is owned by the signed-in user; the key is never sent through the API or
 * included in activity metadata.
 */
export function loadOrCreatePairingTokenKey(dataDirectory: string): Buffer {
  const keyPath = join(dataDirectory, secretFileName);
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath);
    if (key.length !== 32) {
      throw new Error('The DevPilot pairing token key is invalid.');
    }
    return key;
  }

  mkdirSync(dataDirectory, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  return key;
}
