# ================================================================
#  Lab Server Monitor - docker_stats_webhook.ps1
#  Path: C:\Users\Public\docker_stats_webhook.ps1
#  Triggered by: Windows Task Scheduler (every 1 minute)
#  Action: Collect container CPU/MEM + overall GPU stats, POST once, then exit
# ================================================================

$SCRIPT_URL = "YOUR_APPS_SCRIPT_URL"

try {
    # ── 抓所有執行中容器的 CPU / MEM ──────────────────────────
    $statsRaw = docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}" 2>$null
    $containerStats = @{}
    foreach ($line in $statsRaw) {
        $parts = $line -split '\t'
        if ($parts.Count -lt 3) { continue }
        $name   = $parts[0].Trim()
        $cpu    = [math]::Round([double]($parts[1].Trim().TrimEnd('%')), 1)
        $mem    = [math]::Round([double]($parts[2].Trim().TrimEnd('%')), 1)
        $containerStats[$name] = @{ cpu = $cpu; mem = $mem }
    }

    # ── 抓整體 GPU 使用率 ─────────────────────────────────────
    $gpuUtil = 0
    $nvOut = nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null
    if ($nvOut) {
        $vals = @($nvOut | ForEach-Object { [int]$_.Trim() })
        if ($vals.Count -gt 0) {
            $gpuUtil = [math]::Round(($vals | Measure-Object -Average).Average, 0)
        }
    }

    # ── 組成 JSON payload ─────────────────────────────────────
    $statsArr = @()
    foreach ($key in $containerStats.Keys) {
        $statsArr += @{
            name = $key
            cpu  = $containerStats[$key].cpu
            mem  = $containerStats[$key].mem
        }
    }

    $payload = @{
        action     = "stats"
        gpu        = $gpuUtil
        containers = $statsArr
    } | ConvertTo-Json -Compress -Depth 3

    Invoke-WebRequest -Uri $SCRIPT_URL -Method POST -Body $payload `
        -ContentType "application/json" -UseBasicParsing -TimeoutSec 10 | Out-Null

} catch {}
