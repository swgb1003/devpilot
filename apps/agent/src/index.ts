import { readFileSync } from 'node:fs';

import { ActivityStore } from './activity-store.js';
import { loadAgentConfig } from './config.js';
import { createAgentServer, listen } from './server.js';

const config = loadAgentConfig();
const activities = new ActivityStore(config.databasePath);
activities.purgeOlderThan(config.activityRetentionDays);
activities.append({
  kind: 'agent.started',
  severity: 'success',
  message: 'DevPilot Agent core started.',
  metadata: { schemaVersion: activities.schemaVersion() },
});
const tls =
  config.tlsCertificatePath && config.tlsKeyPath
    ? {
        cert: readFileSync(config.tlsCertificatePath),
        key: readFileSync(config.tlsKeyPath),
      }
    : undefined;
const server = createAgentServer({ config, activityStore: activities, ...(tls ? { tls } : {}) });

await listen(server, config.port, config.host);
console.log(
  `DevPilot Agent listening on ${tls ? 'https' : 'http'}://${config.host}:${config.port}`,
);

function shutdown(signal: string): void {
  console.log(`DevPilot Agent received ${signal}; shutting down.`);
  server.close((error) => {
    activities.append({
      kind: 'agent.stopped',
      message: `DevPilot Agent received ${signal}.`,
    });
    activities.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
