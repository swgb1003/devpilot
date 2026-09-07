# Headless Agent — edit a registered project from the phone, PC untouched

Goal: after a one-time setup at the PC, open DevPilot Mobile and run the full
Point & Fix → Codex → Hot Reload loop against a **registered** project without
touching the PC. The PC hardware stays on; nobody sits at it.

This does **not** move the toolchain off the PC. Flutter build, `flutter analyze`,
Hot Reload, file writes, and Codex all still run on the PC Agent. What changes is
that the Agent runs unattended and is reachable from the phone.

## One-time PC setup

1. Register the project once in DevPilot Desktop (folder picker → `pubspec.yaml`
   validated). Registration stays a Desktop action.
2. Install the headless Agent service (Task Scheduler, no extra dependency):

   ```powershell
   pwsh -File scripts/install-agent-service.ps1 -DesktopToken <32+ char token>
   Start-ScheduledTask -TaskName "DevPilot Agent"
   ```

   Omit `-DesktopToken` to have one generated and printed.

3. Windows power settings: enable auto-login, set **Sleep = Never** (or configure
   Wake-on-LAN). A mini PC idles at ~10 W.
4. Pair the phone once from DevPilot Desktop (**Show pairing QR**). Tokens are
   stored in the Android Keystore and survive Agent restarts.

Uninstall: `pwsh -File scripts/install-agent-service.ps1 -Uninstall`.

## Same-Wi-Fi use (default)

Nothing else to configure. The QR already advertises this PC's private LAN
address; the phone reconnects on app resume via `GET /api/v1/mobile/session`
and `GET /jobs/{id}`.

## Reaching the PC from outside the LAN — Tailscale (no self-hosted relay)

1. Install Tailscale on the PC and the phone, sign both into the same tailnet.
2. Note the PC's Tailscale IPv4 (`100.x.y.z`, from `tailscale ip -4`).
3. Re-run the installer with that address so the pairing QR includes it:

   ```powershell
   pwsh -File scripts/install-agent-service.ps1 -DesktopToken <same token> -ExtraHosts 100.x.y.z
   Restart-ScheduledTask -TaskName "DevPilot Agent"
   ```

4. Re-pair the phone (the pinned cert now needs the Tailscale SAN).

`100.64.0.0/10` (RFC 6598) is accepted by both the Agent and the app as a
pairing host. The one-time nonce, Desktop approval, and TLS fingerprint pin
still gate every connection; no public IP is ever advertised.

## Away-from-home device control (best effort)

The Agent can only drive an Android device its `adb` can see. Over Tailscale:

1. On the phone, once while on home Wi-Fi: enable wireless debugging, then
   `adb tcpip 5555` from the PC.
2. Re-run the installer with the phone's Tailscale address:

   ```powershell
   pwsh -File scripts/install-agent-service.ps1 -DesktopToken <same token> `
     -ExtraHosts 100.x.y.z -AdbConnectTargets 100.a.b.c:5555
   Restart-ScheduledTask -TaskName "DevPilot Agent"
   ```

The Agent runs `adb connect` on each target before every device scan and
retries after a drop. Wireless ADB over a tunnel is latency-sensitive and can
drop when the phone sleeps; treat this path as best effort. `flutter run` is
auto-restarted up to 3 times per minute if it dies.

## Environment variables (set by the installer launcher)

| Variable                       | Purpose                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `DEVPILOT_DESKTOP_TOKEN`       | Desktop control-API bearer, >= 32 chars                               |
| `DEVPILOT_DATA_DIR`            | SQLite + artifacts location                                           |
| `DEVPILOT_PAIRING_EXTRA_HOSTS` | Extra QR host candidates (comma-separated private / `100.64/10` IPv4) |
| `DEVPILOT_ADB_CONNECT_TARGETS` | `host:port` wireless-ADB targets (comma-separated)                    |

## Verify

```powershell
Get-ScheduledTask -TaskName "DevPilot Agent"
Invoke-RestMethod http://127.0.0.1:47831/health
```

Then from the phone: resume the app, confirm the session card is live, capture a
screenshot, run one Point & Fix.
