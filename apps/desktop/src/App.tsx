import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

type ProbeStatus = 'available' | 'unavailable' | 'degraded';

interface AdapterProbe {
  readonly adapterId: string;
  readonly capabilities: readonly string[];
  readonly details: readonly string[];
  readonly latencyMs?: number;
  readonly status: ProbeStatus;
}

interface M1ProbeReport {
  readonly adapters: readonly AdapterProbe[];
  readonly generatedAt: string;
  readonly notes: readonly string[];
  readonly tls: {
    readonly fingerprint256: string;
    readonly latencyMs: number;
    readonly status: ProbeStatus;
  };
}

interface AgentStatus {
  readonly endpoint: string;
  readonly message: string;
  readonly pid?: number;
  readonly restartCount: number;
  readonly state: string;
}

interface AgentHealth {
  readonly status: string;
  readonly version: string;
}

const agentEndpoint = 'http://127.0.0.1:47831';

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function statusLabel(status: ProbeStatus): string {
  return status === 'available'
    ? 'Available'
    : status === 'degraded'
      ? 'Needs device'
      : 'Unavailable';
}

export function App() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [report, setReport] = useState<M1ProbeReport | undefined>();
  const [health, setHealth] = useState<AgentHealth | undefined>();

  const refreshReport = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);

    try {
      const [healthResponse, reportResponse] = await Promise.all([
        fetch(`${agentEndpoint}/health`),
        fetch(`${agentEndpoint}/m1/report`),
      ]);
      if (!healthResponse.ok || !reportResponse.ok) {
        throw new Error(
          `Agent responded with HTTP ${healthResponse.status}/${reportResponse.status}.`,
        );
      }

      const healthBody = (await healthResponse.json()) as { data: AgentHealth };
      const reportBody = (await reportResponse.json()) as { data: M1ProbeReport };
      setHealth(healthBody.data);
      setReport(reportBody.data);
    } catch (caughtError) {
      setHealth(undefined);
      setReport(undefined);
      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to reach the local Agent.',
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshSidecarStatus = useCallback(async () => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      setAgentStatus(await invoke<AgentStatus>('agent_status'));
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to inspect the Agent sidecar.',
      );
    }
  }, []);

  useEffect(() => {
    void refreshReport();
    void refreshSidecarStatus();
  }, [refreshReport, refreshSidecarStatus]);

  async function startSidecar(): Promise<void> {
    try {
      setAgentStatus(await invoke<AgentStatus>('agent_start'));
      await refreshReport();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to start the Agent sidecar.',
      );
    }
  }

  async function stopSidecar(): Promise<void> {
    try {
      setAgentStatus(await invoke<AgentStatus>('agent_stop'));
      setReport(undefined);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'Unable to stop the Agent sidecar.',
      );
    }
  }

  const nativeDesktop = isTauriRuntime();

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">
          DP
        </div>
        <div>
          <p className="eyebrow">M2 Agent Core</p>
          <h1 id="page-title">DevPilot Desktop</h1>
          <p className="tagline">Local state, authenticated APIs, Activity, and events.</p>
        </div>
      </section>

      <section className="status-card" aria-labelledby="agent-title">
        <div className="status-heading">
          <div>
            <p className="eyebrow">Desktop ↔ Agent</p>
            <h2 id="agent-title">Local Agent core</h2>
          </div>
          <span className={`status-pill ${health ? 'is-ready' : ''}`}>
            {health ? `Core ${health.version}` : 'Offline'}
          </span>
        </div>

        <div className="connection-content">
          <p>
            {nativeDesktop
              ? (agentStatus?.message ?? 'The Desktop can start and supervise the Node sidecar.')
              : 'Browser preview connects to an Agent started with pnpm dev:agent.'}
          </p>
          {agentStatus ? (
            <p className="muted">
              {agentStatus.endpoint} · {agentStatus.state} · restart attempts:{' '}
              {agentStatus.restartCount}
              {agentStatus.pid ? ` · PID ${agentStatus.pid}` : ''}
            </p>
          ) : null}
          <div className="action-row">
            {nativeDesktop ? (
              <>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void startSidecar()}
                >
                  Start Agent
                </button>
                <button className="quiet-button" type="button" onClick={() => void stopSidecar()}>
                  Stop Agent
                </button>
              </>
            ) : null}
            <button
              className="quiet-button"
              disabled={isLoading}
              type="button"
              onClick={() => void refreshReport()}
            >
              {isLoading ? 'Refreshing…' : 'Refresh core status'}
            </button>
          </div>
        </div>
      </section>

      <section className="status-card probe-card" aria-labelledby="probe-title">
        <div className="status-heading">
          <div>
            <p className="eyebrow">Capability evidence</p>
            <h2 id="probe-title">Flutter & Android probes</h2>
          </div>
          <span className="status-pill">M1 evidence</span>
        </div>

        {error ? <p className="probe-error">{error}</p> : null}
        {report ? (
          <>
            <dl className="check-list">
              {report.adapters.map((adapter) => (
                <div className="check-row probe-row" key={adapter.adapterId}>
                  <dt>
                    <strong>{adapter.adapterId}</strong>
                    <span>
                      {adapter.capabilities.length
                        ? adapter.capabilities.join(' · ')
                        : 'No usable capability yet'}
                    </span>
                  </dt>
                  <dd className={`probe-status ${adapter.status}`}>
                    {statusLabel(adapter.status)}
                  </dd>
                </div>
              ))}
              <div className="check-row probe-row">
                <dt>
                  <strong>local TLS</strong>
                  <span>
                    Ephemeral certificate fingerprint: {report.tls.fingerprint256.slice(0, 16)}…
                  </span>
                </dt>
                <dd className={`probe-status ${report.tls.status}`}>
                  {statusLabel(report.tls.status)}
                </dd>
              </div>
            </dl>
            <div className="probe-notes">
              <p>
                Measured {new Date(report.generatedAt).toLocaleString()} · TLS round trip{' '}
                {report.tls.latencyMs}ms
              </p>
              {report.notes.map((note) => (
                <p className="muted" key={note}>
                  {note}
                </p>
              ))}
            </div>
          </>
        ) : (
          <p className="empty-state">
            Start the Agent, then run the probe to record this Windows environment.
          </p>
        )}
      </section>

      <p className="next-step">
        M2 persists the Agent state and protects Desktop APIs. QR pairing and Mobile credentials
        remain the next M3 security slice.
      </p>
    </main>
  );
}
