mod agent_supervisor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(agent_supervisor::AgentSupervisor::default())
        .invoke_handler(tauri::generate_handler![
            agent_supervisor::agent_start,
            agent_supervisor::agent_status,
            agent_supervisor::agent_stop
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DevPilot Desktop");
}
