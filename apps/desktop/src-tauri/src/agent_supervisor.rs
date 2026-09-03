use std::{
    env,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command},
    sync::Mutex,
};

use serde::Serialize;
use tauri::State;

const AGENT_PORT: u16 = 47_831;
const MAX_AUTOMATIC_RESTARTS: u8 = 1;

pub struct AgentSupervisor {
    state: Mutex<SupervisorState>,
}

struct SupervisorState {
    child: Option<Child>,
    desktop_token: String,
    last_exit: Option<String>,
    restart_count: u8,
}

impl Default for AgentSupervisor {
    fn default() -> Self {
        Self {
            state: Mutex::new(SupervisorState {
                child: None,
                desktop_token: create_desktop_token(),
                last_exit: None,
                restart_count: 0,
            }),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    endpoint: String,
    message: String,
    pid: Option<u32>,
    restart_count: u8,
    state: String,
}

impl AgentSupervisor {
    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("the Tauri crate must be nested under the workspace root")
            .to_path_buf()
    }

    fn endpoint() -> String {
        format!("http://127.0.0.1:{AGENT_PORT}")
    }

    fn ensure_port_available(port: u16) -> Result<(), String> {
        TcpListener::bind(("127.0.0.1", port))
            .map(drop)
            .map_err(|_| {
                format!(
                    "Agent sidecar cannot start because 127.0.0.1:{port} is already in use. Stop the separate `pnpm dev:agent` process, then start DevPilot Desktop again."
                )
            })
    }

    fn spawn_child(desktop_token: &str) -> Result<Child, String> {
        let workspace_root = Self::workspace_root();
        let entrypoint = env::var_os("DEVPILOT_AGENT_ENTRYPOINT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                workspace_root
                    .join("apps")
                    .join("agent")
                    .join("dist")
                    .join("index.js")
            });

        if !entrypoint.is_file() {
            return Err(format!(
                "Agent entrypoint was not found at {}. Build @devpilot/contracts and @devpilot/agent before starting the sidecar.",
                entrypoint.display()
            ));
        }

        let node_binary = env::var_os("DEVPILOT_NODE_BINARY").unwrap_or_else(|| "node.exe".into());
        Command::new(node_binary)
            .arg(entrypoint)
            .current_dir(workspace_root)
            .env("DEVPILOT_AGENT_HOST", "127.0.0.1")
            .env("DEVPILOT_AGENT_PORT", AGENT_PORT.to_string())
            .env("DEVPILOT_DESKTOP_TOKEN", desktop_token)
            .spawn()
            .map_err(|error| format!("Failed to start the DevPilot Agent sidecar: {error}"))
    }

    fn status_from_state(
        state: &SupervisorState,
        state_name: &str,
        message: String,
    ) -> AgentStatus {
        AgentStatus {
            endpoint: Self::endpoint(),
            message,
            pid: state.child.as_ref().map(Child::id),
            restart_count: state.restart_count,
            state: state_name.to_owned(),
        }
    }

    fn refresh_locked(state: &mut SupervisorState) -> Result<(), String> {
        let Some(child) = state.child.as_mut() else {
            return Ok(());
        };

        if let Some(exit_status) = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect Agent sidecar: {error}"))?
        {
            state.child = None;
            state.last_exit = Some(format!("Agent exited with {exit_status}."));
        }

        Ok(())
    }

    fn start_locked(state: &mut SupervisorState, is_restart: bool) -> Result<AgentStatus, String> {
        Self::refresh_locked(state)?;

        if state.child.is_some() {
            return Ok(Self::status_from_state(
                state,
                "running",
                "Agent sidecar is already running.".to_owned(),
            ));
        }

        Self::ensure_port_available(AGENT_PORT)?;
        state.child = Some(Self::spawn_child(&state.desktop_token)?);
        if is_restart {
            state.restart_count += 1;
        } else {
            state.restart_count = 0;
        }
        state.last_exit = None;

        Ok(Self::status_from_state(
            state,
            if is_restart { "restarted" } else { "running" },
            if is_restart {
                "Agent sidecar restarted after an unexpected exit.".to_owned()
            } else {
                "Agent sidecar started.".to_owned()
            },
        ))
    }

    pub fn start(&self) -> Result<AgentStatus, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Agent sidecar state is unavailable.".to_owned())?;
        Self::start_locked(&mut state, false)
    }

    pub fn status(&self) -> Result<AgentStatus, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Agent sidecar state is unavailable.".to_owned())?;
        Self::refresh_locked(&mut state)?;

        if state.child.is_none()
            && state.last_exit.is_some()
            && state.restart_count < MAX_AUTOMATIC_RESTARTS
        {
            return Self::start_locked(&mut state, true);
        }

        if state.child.is_some() {
            return Ok(Self::status_from_state(
                &state,
                "running",
                "Agent sidecar is running.".to_owned(),
            ));
        }

        Ok(Self::status_from_state(
            &state,
            "stopped",
            state
                .last_exit
                .clone()
                .unwrap_or_else(|| "Agent sidecar has not been started.".to_owned()),
        ))
    }

    pub fn stop(&self) -> Result<AgentStatus, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Agent sidecar state is unavailable.".to_owned())?;

        if let Some(mut child) = state.child.take() {
            child
                .kill()
                .map_err(|error| format!("Failed to stop Agent sidecar: {error}"))?;
            child
                .wait()
                .map_err(|error| format!("Failed to wait for Agent sidecar shutdown: {error}"))?;
        }

        state.last_exit = Some("Agent sidecar stopped by Desktop.".to_owned());
        state.restart_count = MAX_AUTOMATIC_RESTARTS;
        Ok(Self::status_from_state(
            &state,
            "stopped",
            "Agent sidecar stopped.".to_owned(),
        ))
    }

    pub fn desktop_token(&self) -> Result<String, String> {
        self.state
            .lock()
            .map(|state| state.desktop_token.clone())
            .map_err(|_| "Agent sidecar state is unavailable.".to_owned())
    }
}

fn create_desktop_token() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).expect("the operating system must provide random bytes");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl Drop for AgentSupervisor {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            if let Some(child) = state.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
pub fn agent_start(supervisor: State<'_, AgentSupervisor>) -> Result<AgentStatus, String> {
    supervisor.start()
}

#[tauri::command]
pub fn agent_status(supervisor: State<'_, AgentSupervisor>) -> Result<AgentStatus, String> {
    supervisor.status()
}

#[tauri::command]
pub fn agent_stop(supervisor: State<'_, AgentSupervisor>) -> Result<AgentStatus, String> {
    supervisor.stop()
}

#[tauri::command]
pub fn agent_desktop_token(supervisor: State<'_, AgentSupervisor>) -> Result<String, String> {
    supervisor.desktop_token()
}

#[cfg(test)]
mod tests {
    use super::AgentSupervisor;

    #[test]
    fn resolves_the_workspace_root_from_the_tauri_crate() {
        let root = AgentSupervisor::workspace_root();
        assert!(root.join("apps").join("agent").is_dir());
        assert!(root.join("packages").join("contracts").is_dir());
    }

    #[test]
    fn starts_restarts_once_after_a_crash_and_stops_the_agent() {
        let supervisor = AgentSupervisor::default();
        let token = supervisor
            .desktop_token()
            .expect("the token should be available");
        assert_eq!(token.len(), 64);
        let started = supervisor.start().expect("the Agent sidecar should start");
        assert_eq!(started.state, "running");
        assert!(started.pid.is_some());

        {
            let mut state = supervisor
                .state
                .lock()
                .expect("the sidecar state should be available");
            let child = state
                .child
                .as_mut()
                .expect("the sidecar process should be present");
            child
                .kill()
                .expect("the sidecar process should be killable");
            child
                .wait()
                .expect("the sidecar process should exit after a kill");
        }

        let restarted = supervisor
            .status()
            .expect("the sidecar should be restarted once");
        assert_eq!(restarted.state, "restarted");
        assert_eq!(restarted.restart_count, 1);
        assert!(restarted.pid.is_some());
        assert_eq!(supervisor.desktop_token().unwrap(), token);

        let stopped = supervisor
            .stop()
            .expect("the sidecar should stop gracefully");
        assert_eq!(stopped.state, "stopped");
    }

    #[test]
    fn reports_when_the_agent_port_is_already_reserved() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .expect("an ephemeral loopback port should be available");
        let port = listener
            .local_addr()
            .expect("the listener should have an address")
            .port();

        let error = AgentSupervisor::ensure_port_available(port)
            .expect_err("the occupied port must not be used for a sidecar");
        assert!(error.contains(&port.to_string()));
    }
}
