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
interface RegisteredProject { readonly id: string; readonly name: string; readonly rootPath: string; readonly status: string }
interface AndroidDevice { readonly id: string; readonly name: string; readonly isAuthorized: boolean }
interface DevSession { readonly id: string; readonly projectId: string; readonly deviceId: string; readonly state: string; readonly detail?: string }

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
  const [projects, setProjects] = useState<readonly RegisteredProject[]>([]);
  const [devices, setDevices] = useState<readonly AndroidDevice[]>([]);
  const [session, setSession] = useState<DevSession | undefined>();
  const [projectPath, setProjectPath] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [m4Error, setM4Error] = useState<string | undefined>();

  const refreshM4 = useCallback(async () => {
    try {
      const [projectsResponse, devicesResponse, sessionResponse] = await Promise.all([
        fetch(`${agentEndpoint}/api/v1/projects`), fetch(`${agentEndpoint}/api/v1/devices`), fetch(`${agentEndpoint}/api/v1/session`),
      ]);
      if (!projectsResponse.ok || !devicesResponse.ok || !sessionResponse.ok) throw new Error('AgentのM4 APIへ接続できません。');
      const projectData = (await projectsResponse.json()) as { data: RegisteredProject[] };
      const deviceData = (await devicesResponse.json()) as { data: AndroidDevice[] };
      const sessionData = (await sessionResponse.json()) as { data: DevSession | null };
      setProjects(projectData.data); setDevices(deviceData.data); setSession(sessionData.data ?? undefined);
      setSelectedProjectId((current) => current || projectData.data[0]?.id || '');
    } catch (caught) { setM4Error(caught instanceof Error ? caught.message : 'M4の状態を取得できません。'); }
  }, []);

  useEffect(() => { void refreshM4(); }, [refreshM4]);
  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch(`${agentEndpoint}/api/v1/session`);
      if (!response.ok) throw new Error('Agentのセッション状態を取得できません。');
      const body = (await response.json()) as { data: DevSession | null };
      setSession(body.data ?? undefined);
    } catch (caught) {
      setM4Error(caught instanceof Error ? caught.message : 'セッション状態を取得できません。');
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshSession(); }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshSession]);

  const refreshDevices = useCallback(async () => {
    try {
      const response = await fetch(`${agentEndpoint}/api/v1/devices`);
      if (!response.ok) throw new Error('Android端末の状態を取得できません。');
      const body = (await response.json()) as { data: AndroidDevice[] };
      setDevices(body.data);
      if (body.data.some((device) => device.isAuthorized)) setM4Error(undefined);
    } catch (caught) {
      setM4Error(caught instanceof Error ? caught.message : 'Android端末の状態を取得できません。');
    }
  }, []);

  useEffect(() => {
    if (devices.some((device) => device.isAuthorized)) return undefined;
    void refreshDevices();
    const timer = window.setInterval(() => { void refreshDevices(); }, 5000);
    return () => window.clearInterval(timer);
  }, [devices, refreshDevices]);

  const registerProject = useCallback(async () => {
    setM4Error(undefined);
    try { const response = await fetch(`${agentEndpoint}/api/v1/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rootPath: projectPath }) }); if (!response.ok) throw new Error(((await response.json()) as { error?: { message?: string } }).error?.message ?? 'プロジェクトを登録できません。'); setProjectPath(''); await refreshM4(); } catch (caught) { setM4Error(caught instanceof Error ? caught.message : 'プロジェクトを登録できません。'); }
  }, [projectPath, refreshM4]);
  const startSession = useCallback(async () => {
    const device = devices.find((item) => item.isAuthorized); if (!selectedProjectId || !device) { setM4Error('Flutterプロジェクトとauthorized Android端末を選択してください。'); return; }
    setM4Error(undefined); try { const response = await fetch(`${agentEndpoint}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: selectedProjectId, deviceId: device.id }) }); if (!response.ok) throw new Error(((await response.json()) as { error?: { message?: string } }).error?.message ?? 'セッションを開始できません。'); await refreshM4(); } catch (caught) { setM4Error(caught instanceof Error ? caught.message : 'セッションを開始できません。'); }
  }, [devices, selectedProjectId, refreshM4]);
  const stopSession = useCallback(async () => { if (!session) return; await fetch(`${agentEndpoint}/api/v1/sessions/${session.id}/stop`, { method: 'POST' }); await refreshM4(); }, [session, refreshM4]);
  const chooseProjectFolder = useCallback(async () => {
    if (!isTauriRuntime()) {
      setM4Error('フォルダ選択はDevPilot Desktopアプリで利用できます。ブラウザ表示ではパスを貼り付けてください。');
      return;
    }
    try {
      const selected = await invoke<string | null>('select_flutter_project_folder');
      if (selected) setProjectPath(selected);
    } catch (caught) {
      setM4Error(caught instanceof Error ? caught.message : 'フォルダを選択できませんでした。');
    }
  }, []);

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

      <section className="status-card pairing-card" aria-labelledby="m4-title">
        <div className="status-heading"><div><p className="eyebrow">M4 Project / Session</p><h2 id="m4-title">Flutter開発セッション</h2></div><span className={`status-pill ${session?.state === 'running' ? 'is-ready' : ''}`}>{session?.state ?? 'Ready to set up'}</span></div>
        <div className="pairing-content"><div className="pairing-copy">
          <p>Flutterアプリフォルダ（中に <code>pubspec.yaml</code> があるフォルダ）を登録し、検出済みのAndroid実機でAgent管理の <code>flutter run</code> を開始します。</p>
          <input className="project-path-input" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="Flutterアプリフォルダのパスを貼り付け 例: C:\\work\\my_flutter_app" />
          <button className="quiet-button" type="button" onClick={() => void chooseProjectFolder()}>アプリフォルダを選択</button>
          <button className="quiet-button" type="button" onClick={() => void navigator.clipboard.readText().then(setProjectPath).catch(() => setM4Error('クリップボードを読み取れませんでした。パスを入力欄へ貼り付けてください。'))}>クリップボードから貼り付け</button>
          <button className="quiet-button" type="button" disabled={!projectPath} onClick={() => void registerProject()}>プロジェクトを登録</button>
          <select className="project-path-input" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}><option value="">プロジェクトを選択</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.rootPath}</option>)}</select>
          <p className="muted">Android: {devices.filter((device) => device.isAuthorized).map((device) => device.name).join(', ') || '検出されていません'}</p>
          {session?.state === 'starting' || session?.state === 'running' ? <button className="primary-button" type="button" onClick={() => void stopSession()}>開発セッションを終了</button> : <button className="primary-button" type="button" onClick={() => void startSession()}>Open Dev Session</button>}
          {session?.detail ? <p className="muted">{session.detail}</p> : null}{m4Error ? <p className="pairing-error">{m4Error}</p> : null}
        </div><div className="pairing-qr-placeholder" aria-hidden="true">M4</div></div>
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
