mod agent_supervisor;

#[tauri::command]
fn select_flutter_project_folder() -> Result<Option<String>, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Flutterアプリフォルダ（pubspec.yaml があるフォルダ）を選択してください'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
"#;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .map_err(|error| format!("フォルダ選択ダイアログを起動できません: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!selected.is_empty()).then_some(selected))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(agent_supervisor::AgentSupervisor::default())
        .invoke_handler(tauri::generate_handler![
            agent_supervisor::agent_start,
            agent_supervisor::agent_status,
            agent_supervisor::agent_stop,
            agent_supervisor::agent_desktop_token,
            select_flutter_project_folder
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DevPilot Desktop");
}
