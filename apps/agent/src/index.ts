import { ActivityStore } from './activity-store.js';
import { loadAgentConfig } from './config.js';
import { loadOrCreatePairingTokenKey } from './credential-store.js';
import { PairingService } from './pairing-service.js';
import { PairingStore } from './pairing-store.js';
import { loadOrCreatePairingTls, privateIpv4Addresses } from './pairing-tls.js';
import { createAgentServer, listen } from './server.js';

const config = loadAgentConfig();
const activities = new ActivityStore(config.databasePath);
const pairingHosts = privateIpv4Addresses();
const pairingTls = await loadOrCreatePairingTls(config.dataDirectory, pairingHosts);
const pairings = new PairingService(
  new PairingStore(config.databasePath, loadOrCreatePairingTokenKey(config.dataDirectory)),
  activities,
  {
    hostCandidates: pairingHosts,
    port: config.pairingPort,
    fingerprint: pairingTls.fingerprint,
  },
);
activities.purgeOlderThan(config.activityRetentionDays);
activities.append({
  kind: 'agent.started',
  severity: 'success',
  message: 'DevPilot Agent core started.',
  metadata: { schemaVersion: activities.schemaVersion() },
});
const desktopServer = createAgentServer({
  config,
  activityStore: activities,
  pairingService: pairings,
});
const mobileServer = createAgentServer({
  config: { ...config, host: '0.0.0.0', port: config.pairingPort },
  activityStore: activities,
  pairingService: pairings,
  tls: { cert: pairingTls.cert, key: pairingTls.key },
});

await listen(desktopServer, config.port, config.host);
await listen(mobileServer, config.pairingPort, '0.0.0.0');
console.log(
  `DevPilot Desktop API listening on http://${config.host}:${config.port}; ` +
    `Mobile pairing API listening on https://0.0.0.0:${config.pairingPort}`,
);

function shutdown(signal: string): void {
  console.log(`DevPilot Agent received ${signal}; shutting down.`);
  desktopServer.close((desktopError) => {
    mobileServer.close((mobileError) => {
      activities.append({
        kind: 'agent.stopped',
        message: `DevPilot Agent received ${signal}.`,
      });
      pairings.close();
      activities.close();
      if (desktopError || mobileError) {
        console.error(desktopError ?? mobileError);
        process.exitCode = 1;
      }
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
