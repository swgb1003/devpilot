import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { generate } from 'selfsigned';

export interface PairingTlsMaterial {
  readonly cert: string;
  readonly key: string;
  readonly fingerprint: string;
}

export function privateIpv4Addresses(): readonly string[] {
  const candidates = new Set<string>();
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    if (/virtual|vmware|vbox|hyper-v|wsl|loopback/i.test(interfaceName)) {
      continue;
    }
    for (const address of addresses ?? []) {
      if (
        address.family !== 'IPv4' ||
        address.internal ||
        !isPrivateIpv4(address.address) ||
        isKnownVirtualHostOnlyAddress(address.address)
      ) {
        continue;
      }
      candidates.add(address.address);
    }
  }
  return [...candidates].sort((left, right) => {
    const leftPreferred = left.startsWith('192.168.') ? 0 : 1;
    const rightPreferred = right.startsWith('192.168.') ? 0 : 1;
    return leftPreferred - rightPreferred;
  });
}

// These are the default host-only ranges created by VirtualBox and VMware.
// They are reachable from the development PC but not from a phone on Wi-Fi,
// so advertising them in a pairing QR would make device connection unreliable.
function isKnownVirtualHostOnlyAddress(address: string): boolean {
  return (
    address.startsWith('192.168.56.') ||
    address.startsWith('192.168.58.') ||
    address.startsWith('192.168.213.')
  );
}

export async function loadOrCreatePairingTls(
  dataDirectory: string,
  hostCandidates: readonly string[],
): Promise<PairingTlsMaterial> {
  const certificatePath = join(dataDirectory, 'pairing-cert.pem');
  const keyPath = join(dataDirectory, 'pairing-key.pem');
  if (existsSync(certificatePath) && existsSync(keyPath)) {
    return withFingerprint(readFileSync(certificatePath, 'utf8'), readFileSync(keyPath, 'utf8'));
  }

  mkdirSync(dataDirectory, { recursive: true });
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  const certificate = await generate([{ name: 'commonName', value: 'DevPilot Local Agent' }], {
    algorithm: 'sha256',
    keySize: 2048,
    notAfterDate: expiresAt,
    notBeforeDate: issuedAt,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: hostCandidates.map((ip) => ({ type: 7, ip })),
      },
    ],
  });
  writeFileSync(certificatePath, certificate.cert, { mode: 0o600, flag: 'wx' });
  writeFileSync(keyPath, certificate.private, { mode: 0o600, flag: 'wx' });
  return withFingerprint(certificate.cert, certificate.private);
}

function withFingerprint(cert: string, key: string): PairingTlsMaterial {
  const certificate = new X509Certificate(cert);
  return {
    cert,
    key,
    fingerprint: `sha256/${createHash('sha256').update(certificate.raw).digest('hex').toUpperCase()}`,
  };
}

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    // RFC 6598 shared address space (100.64.0.0/10). Tailscale and other
    // WireGuard meshes assign phone-reachable addresses from this range, so a
    // headless Agent can be paired from outside the local Wi-Fi.
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
  );
}
