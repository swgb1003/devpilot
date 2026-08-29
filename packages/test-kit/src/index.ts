import type { AgentHealth } from '@devpilot/contracts';

export const readyAgentFixture: AgentHealth = {
  name: 'devpilot-agent',
  version: '0.1.0-test',
  protocolVersion: 1,
  status: 'ready',
  occurredAt: '2026-08-26T00:00:00.000Z',
};
