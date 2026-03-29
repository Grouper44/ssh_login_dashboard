# ================================================================
#  Lab Server Monitor - ssh_webhook.ps1
#  Path: C:\Users\Public\ssh_webhook.ps1
#  Triggered by: Windows Task Scheduler (OpenSSH EventID=4)
#  Action: Send SSH login webhook once, then exit
# ================================================================

$SCRIPT_URL = "YOUR_APPS_SCRIPT_URL"

try {
    $ip = (Get-NetTCPConnection -LocalPort 22 -State Established -ErrorAction SilentlyContinue |
           Select-Object -First 1).RemoteAddress
    if (-not $ip) { $ip = "Unknown" }

    $body = "action=login&user=labuser&ip=$([uri]::EscapeDataString($ip))"
    Invoke-WebRequest -Uri $SCRIPT_URL -Method POST -Body $body -ContentType "application/x-www-form-urlencoded" -UseBasicParsing -TimeoutSec 10 | Out-Null
} catch {}
