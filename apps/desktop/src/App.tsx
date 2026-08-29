import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';

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

interface PairingQrPayload {
  readonly pairingId: string;
  readonly hostCandidates: readonly string[];
  readonly port: number;
  readonly expiresAt: string;
  readonly serverPublicKeyFingerprint: string;
}

interface PairingChallenge {
  readonly id: string;
  readonly status: 'awaiting_confirmation' | 'awaiting_approval' | 'approved';
  readonly expiresAt: string;
  readonly qrPayload: PairingQrPayload;
}

interface PairingState {
  readonly id: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly device?: { readonly displayName: string; readonly publicKey: string };
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
  const [pairing, setPairing] = useState<PairingChallenge | undefined>();
  const [pairingState, setPairingState] = useState<PairingState | undefined>();
  const [qrImage, setQrImage] = useState<string | undefined>();
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [isPairingLoading, setIsPairingLoading] = useState(false);

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

  const refreshPairing = useCallback(async (pairingId: string) => {
    const response = await fetch(`${agentEndpoint}/api/v1/pairings/${pairingId}`);
    if (!response.ok) {
      throw new Error(`Pairing status request failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { data: PairingState };
    setPairingState(body.data);
    return body.data;
  }, []);

  useEffect(() => {
    if (!pairing || pairingState?.status === 'approved') {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refreshPairing(pairing.id).catch((caughtError: unknown) => {
        setPairingError(
          caughtError instanceof Error ? caughtError.message : 'Unable to refresh pairing status.',
        );
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pairing, pairingState?.status, refreshPairing]);

  const createPairing = useCallback(async () => {
    setIsPairingLoading(true);
    setPairingError(undefined);
    try {
      const response = await fetch(`${agentEndpoint}/api/v1/pairings`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(
          body.error?.message ?? `Pairing request failed with HTTP ${response.status}.`,
        );
      }
      const body = (await response.json()) as { data: PairingChallenge };
      const image = await QRCode.toDataURL(JSON.stringify(body.data.qrPayload), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
      });
      setPairing(body.data);
      setPairingState({
        id: body.data.id,
        status: body.data.status,
        expiresAt: body.data.expiresAt,
      });
      setQrImage(image);
    } catch (caughtError) {
      setPairingError(
        caughtError instanceof Error ? caughtError.message : 'Unable to create a pairing QR code.',
      );
    } finally {
      setIsPairingLoading(false);
    }
  }, []);

  const approvePairing = useCallback(async () => {
    if (!pairing) {
      return;
    }
    setIsPairingLoading(true);
    setPairingError(undefined);
    try {
      const response = await fetch(`${agentEndpoint}/api/v1/pairings/${pairing.id}/approve`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`Pairing approval failed with HTTP ${response.status}.`);
      }
      await refreshPairing(pairing.id);
    } catch (caughtError) {
      setPairingError(
        caughtError instanceof Error ? caughtError.message : 'Unable to approve the mobile device.',
      );
    } finally {
      setIsPairingLoading(false);
    }
  }, [pairing, refreshPairing]);

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
          <p className="eyebrow">M3 Pairing Slice</p>
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

      <section className="status-card pairing-card" aria-labelledby="pairing-title">
        <div className="status-heading">
          <div>
            <p className="eyebrow">Secure pairing</p>
            <h2 id="pairing-title">Connect an Android device</h2>
          </div>
          <span className={`status-pill ${pairingState?.status === 'approved' ? 'is-ready' : ''}`}>
            {pairingState?.status === 'approved' ? 'Paired' : '120 sec QR'}
          </span>
        </div>
        <div className="pairing-content">
          <div className="pairing-copy">
            <p>
              Create a one-time QR code, then scan it in DevPilot Mobile on the same private LAN.
              The phone verifies this PC&apos;s certificate fingerprint before it asks for approval.
            </p>
            {pairingState?.device ? (
              <div className="device-request">
                <strong>{pairingState.device.displayName}</strong>
                <span>
                  {pairingState.status === 'awaiting_approval'
                    ? 'This device is requesting access.'
                    : 'Secure token issued to this device.'}
                </span>
              </div>
            ) : null}
            {pairingState?.status === 'awaiting_approval' ? (
              <button
                className="primary-button"
                disabled={isPairingLoading}
                type="button"
                onClick={() => void approvePairing()}
              >
                Approve this device
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={isPairingLoading}
                type="button"
                onClick={() => void createPairing()}
              >
                {isPairingLoading ? 'Creating…' : 'Show pairing QR'}
              </button>
            )}
            {pairing ? (
              <p className="muted pairing-expiry">
                Expires {new Date(pairing.expiresAt).toLocaleTimeString()} ·{' '}
                {pairing.qrPayload.hostCandidates.join(', ')}: {pairing.qrPayload.port}
              </p>
            ) : null}
            {pairingError ? <p className="pairing-error">{pairingError}</p> : null}
          </div>
          {qrImage && pairingState?.status !== 'approved' ? (
            <img className="pairing-qr" src={qrImage} alt="DevPilot pairing QR code" />
          ) : (
            <div className="pairing-qr-placeholder" aria-hidden="true">
              QR
            </div>
          )}
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
        M3 adds a real pairing boundary. Project and development-session setup remain the next M4
        slice.
      </p>
    </main>
  );
}
