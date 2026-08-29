import { createHash, X509Certificate } from 'node:crypto';
import { createServer, get } from 'node:https';
import type { AddressInfo } from 'node:net';

import { generate } from 'selfsigned';

import type { TlsProbe } from '@devpilot/contracts';

export async function runLocalTlsProbe(): Promise<TlsProbe> {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt);
  expiresAt.setDate(expiresAt.getDate() + 7);

  const certificate = await generate([{ name: 'commonName', value: 'localhost' }], {
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
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  const certificateDetails = new X509Certificate(certificate.cert);
  const fingerprint256 = createHash('sha256')
    .update(certificateDetails.raw)
    .digest('hex')
    .toUpperCase();
  const server = createServer(
    { cert: certificate.cert, key: certificate.private },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = server.address() as AddressInfo;
    const startedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      const request = get(
        {
          host: '127.0.0.1',
          path: '/',
          port: address.port,
          rejectUnauthorized: false,
        },
        (response) => {
          response.resume();
          response.once('end', () => {
            if (response.statusCode === 200) {
              resolve();
              return;
            }
            reject(new Error(`TLS probe received HTTP ${response.statusCode ?? 'unknown'}.`));
          });
        },
      );
      request.once('error', reject);
    });

    return {
      status: 'available',
      host: '127.0.0.1',
      port: address.port,
      fingerprint256,
      latencyMs: Math.round(performance.now() - startedAt),
      expiresAt: expiresAt.toISOString(),
      details: [
        'A new ephemeral RSA certificate is generated for each probe.',
        'The client verifies a successful HTTPS round trip only; this is not pairing trust.',
      ],
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
