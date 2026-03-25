# ================================================================
#  Lab Server Monitor - ssh_webhook.ps1
#  Path: C:\Users\Public\ssh_webhook.ps1
#  Triggered by: Windows Task Scheduler (OpenSSH EventID=4)
#  Action: Send SSH login webhook once, then exit
# ================================================================

$SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx2Z_XU3fzLHqpLu_BlNEM10_JWXqfLMiGoyCNVaXUP1Dqj7gwTIhiqVnTPYFvdFHs/exec"

try {
    $ip = (Get-NetTCPConnection -LocalPort 22 -State Established -ErrorAction SilentlyContinue |
           Select-Object -First 1).RemoteAddress
    if (-not $ip) { $ip = "Unknown" }

    $body = "action=login&user=labuser&ip=$([uri]::EscapeDataString($ip))"
    Invoke-WebRequest -Uri $SCRIPT_URL -Method POST -Body $body -ContentType "application/x-www-form-urlencoded" -UseBasicParsing -TimeoutSec 10 | Out-Null
} catch {}
