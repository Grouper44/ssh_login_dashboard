# 研究室伺服器監控系統

## 系統架構概覽

```
SSH 登入
  └─ Windows 事件觸發器 (OpenSSH EventID=4)
       └─ 排程任務 SSH_Login_Logger
            └─ ssh_webhook.ps1 → POST to Apps Script（送完即結束，不需常駐）

Docker 容器進入
  └─ 容器內 /root/.bashrc 的 curl 指令
       └─ POST to Apps Script（60 秒內同一容器只送一次）

資源監測（CPU / MEM / GPU）
  └─ 排程任務 Docker_Stats_Logger（每 1 分鐘觸發）
       └─ docker_stats_webhook.ps1
            ├─ docker stats --no-stream → 各容器 CPU% / MEM%
            └─ nvidia-smi → 整體 GPU 平均使用率
            → POST JSON to Apps Script（送完即結束，不需常駐）

            ↓
Google Apps Script (Web App)
  ├─ doPost()   ← 接收事件，寫入 Google Sheets + 通知 Telegram
  │              （同一 user+ip 60 秒內重複送達會被擋下不寫入）
  │              （action=stats 不寫 Sheets，只更新 PropertiesService 最新一筆）
  └─ doGet()    ← 回傳 JSON 資料給前端
            ↓
Google Sheets
  ├─ 工作表1        ← SSH 登入紀錄
  └─ 容器進入紀錄   ← Docker 容器連線紀錄
            ↓
GitHub Pages (index.html)  ← 管理員監控介面
```

> **不需要常駐 PowerShell**。SSH 由排程任務事件觸發，Docker 由容器內 `.bashrc` 觸發。

---

## 檔案清單

| 檔案 | 路徑 | 說明 |
|------|------|------|
| `ssh_webhook.ps1` | `C:\Users\Public\ssh_webhook.ps1` | SSH 登入時由排程觸發，送一次 webhook 後結束 |
| `docker_stats_webhook.ps1` | `C:\Users\Public\docker_stats_webhook.ps1` | 每分鐘由排程觸發，抓容器 CPU/MEM 與整體 GPU 使用率，POST 後結束 |
| `apps_script.js` | Google Apps Script 編輯器 | 後端資料處理 |
| `index.html` | GitHub repo 根目錄 | 前端監控介面 |

---

## 一、SSH 連線方式

### 前提條件

- 已安裝 Tailscale 並加入研究室網路（請聯絡管理員）
- 已安裝 VS Code 擴充套件：Remote - SSH、Dev Containers

### 連線步驟

1. 確認 Tailscale 已開啟且成功連線。
2. 打開 VS Code，點左側 Remote Explorer，新增 SSH 連線：

```bash
ssh labuser@<Tailscale IP>   # IP 請向管理員取得
```

3. 連線成功後，VS Code 左下角會顯示 `SSH: <IP>`。

### 進入 Docker 容器

1. 點 VS Code 左下角綠色 `><` 圖示。
2. 選擇 **Attach to Running Container...**，選擇你的容器（`Jane_Con`、`Ting_Con`、`TJ_Con`、`SPY_Con`）。

---

## 二、SSH 登入觸發機制

### 排程任務：SSH_Login_Logger

- **位置：** Windows 工作排程器 `\SSH_Login_Logger`
- **觸發條件：** `OpenSSH/Operational` 事件日誌，EventID=4（SSH 登入成功）
- **執行：** `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Public\ssh_webhook.ps1"`

### ssh_webhook.ps1 功能

取得目前 Port 22 Established 連線的來源 IP，POST 一次 `action=login` webhook，然後結束。不需要常駐。

### 設定項目

```powershell
# 第一行，換成你的 Apps Script URL
$SCRIPT_URL = "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec"
```

---

## 三、Docker 容器進入觸發機制

### 容器內 /root/.bashrc

每個容器的 `.bashrc` 底部有以下片段，每次使用者開啟 bash session 時自動執行：

```bash
# ======== 容器進入通知 ========
CON_ID=$(hostname)
WEBHOOK_URL="https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec?action=container"
CACHE_FILE="/tmp/con_gate"
CUR_TIME=$(date +%s)
if [ -f "$CACHE_FILE" ]; then
    LAST_TIME=$(cat "$CACHE_FILE")
    if [ $((CUR_TIME - LAST_TIME)) -lt 60 ]; then return 0 2>/dev/null || exit 0; fi
fi
echo "$CUR_TIME" > "$CACHE_FILE"
curl -s -d "user=$CON_ID&ip=$CON_ID" -X POST "$WEBHOOK_URL" > /dev/null 2>&1 &
# ======================================
```

- **Throttle：** `/tmp/con_gate` 快取上次送出時間，60 秒內同一容器只送一次
- **容器清單：** TJ_Con、Ting_Con、Jane_Con、SPY_Con

### 修改所有容器 throttle 時間

```powershell
foreach ($con in @("TJ_Con", "Ting_Con", "Jane_Con", "SPY_Con")) {
    docker exec $con sed -i 's/if \[ \$((CUR_TIME - LAST_TIME)) -lt [0-9]* \]/if [ $((CUR_TIME - LAST_TIME)) -lt 60 ]/' /root/.bashrc
    Write-Host "Done: $con"
}
```

---

## 四、Google Apps Script

### 設定項目

```javascript
var TELEGRAM_TOKEN = "你的 Bot Token";
var CHAT_ID        = "你的 Chat ID";
```

### Throttle 機制（server side）

`doPost()` 在寫入前會呼叫 `isThrottled()`，檢查同一 `user+ip` 在該 sheet 最近 60 秒內是否已有紀錄，有則直接回傳 `THROTTLED` 不寫入也不通知。同時套用於 SSH 登入（工作表1）和容器進入（容器進入紀錄）。

### 接收的 action 類型

| action | 說明 | 寫入位置 |
|--------|------|----------|
| `login` | SSH 登入 | 工作表1 |
| `container` / `container_login` | 容器連線 | 容器進入紀錄 |
| `stats` | 容器資源數據（JSON body） | PropertiesService（只保留最新一筆，不寫 Sheets） |

### doGet 回傳的 JSON 結構

```json
{
  "logs": [
    { "time": "2026-03-25 16:48:41", "type": "ssh|container", "user": "labuser", "ip": "1.2.3.4" }
  ],
  "online": [
    { "name": "SPY_Con", "ip": "d455ff67a2b2", "type": "container", "duration": "14m" }
  ],
  "containers": [
    { "name": "d455ff67a2b2", "owner": "SPY_Con", "status": "active|idle|stopped", "cpu": 12.5, "mem": 34.2, "gpu": 67 }
  ],
  "gpuUtil": 67,
  "hourStats": [0,0,0],
  "userStats": { "labels": ["SPY_Con","TJ_Con"], "data": [19, 2] },
  "weekStats": { "labels": ["Mon","Tue"], "data": [12,18] }
}
```

### 重新部署步驟

每次修改 Apps Script 後必須重新部署：

1. 右上角「部署」→「管理部署」
2. 點編輯（鉛筆圖示）
3. 版本選「**新版本**」
4. 點「部署」

---

## 五、前端介面

**部署位置：** GitHub Pages
**網址：** `https://grouper44.github.io/ssh_login_dashboard`

### 功能模組

| 區塊 | 說明 |
|------|------|
| 頂部 Topbar | 即時時鐘、手動重新整理 |
| 4 個 Metric 卡片 | 目前在線人數、今日登入次數、活躍容器數、GPU 整體使用率 |
| 目前在線清單 | 顯示在線使用者、連線 IP、類型（SSH/容器）、連線時長 |
| 最近紀錄表格 | 可過濾 SSH/容器、搜尋使用者；固定高度顯示約 10 筆，可捲動查看最多 200 筆 |
| 24 小時登入分布圖 | 長條圖，顯示今日各小時登入次數 |
| 使用者使用量圖 | 橫條圖，只統計容器使用次數（排除 labuser） |
| 容器狀態卡片 | 每個容器的名稱、擁有者、active/idle/stopped 狀態、CPU%、MEM%、GPU%（整體） |
| 7 天登入趨勢圖 | 折線圖，顯示最近 7 天總登入次數 |

### 資料刷新

- 頁面載入時自動抓取
- 每 **60 秒**自動重新整理一次
- 可手動點「↻ 重新整理」

### 更新介面

直接在 GitHub 上編輯 `index.html` → Commit，幾秒後自動更新。

---

## 六、Google Sheets 結構

### 工作表1（SSH 登入）

| 欄位 | 說明 |
|------|------|
| A - 時間 | `yyyy-MM-dd HH:mm:ss` |
| B - 使用者 | SSH 登入帳號（目前統一為 `labuser`） |
| C - IP位置 | 來源 IP |

### 容器進入紀錄

| 欄位 | 說明 |
|------|------|
| A - 時間 | `yyyy-MM-dd HH:mm:ss` |
| B - 使用者/容器名稱 | 容器名稱（如 `SPY_Con`、`TJ_Con`） |
| C - IP/容器ID | 容器名稱（hostname） |

---

## 七、Telegram 通知

| 事件 | 通知內容 |
|------|---------|
| SSH 登入 | 使用者名稱、來源 IP、時間 |
| 容器連線 | 容器名稱、容器 ID、時間 |

---

## 八、已知限制

| 項目 | 限制 |
|------|------|
| 容器 GPU | 顯示整體 GPU 平均使用率，無法區分各容器個別使用量（Windows 上 PID namespace 對應困難） |
| SSH 使用者識別 | 所有人共用 `labuser` 帳號，無法區分個人 |
| 容器 throttle 重置 | 容器重啟後 `/tmp/con_gate` 消失，下次進入會立即送出（正常行為） |
| stats 更新頻率 | 每 1 分鐘更新一次，前端 60 秒刷新，最大誤差約 2 分鐘 |

---

## 九、後續可擴充的功能

- **個人 SSH 帳號**：為每位研究生建立獨立帳號，改善在線識別準確度
- **每日報表**：用 Apps Script 的 Time-driven Trigger，每天早上自動發送昨日使用統計到 Telegram
- **異常偵測**：非正常時間（深夜）有人登入時發送警告通知
- **容器個別 GPU**：若改為 Linux Docker host，可透過 PID namespace 對應各容器 GPU 使用量

---

## 十、變更紀錄

### 2026-03-30：新增資源監測（CPU / MEM / GPU）

1. **`docker_stats_webhook.ps1`**（新增）
   - Windows Task Scheduler 每 1 分鐘觸發一次，執行完畢即結束，不常駐
   - `docker stats --no-stream` 抓所有執行中容器的 CPU% 和 MEM%
   - `nvidia-smi` 抓所有 GPU 的平均使用率
   - 以 JSON POST 給 Apps Script（`action=stats`）

2. **`apps_script.js`**
   - `doPost` 支援 JSON body（`Content-Type: application/json`），action 從 body 讀取
   - 新增 `action=stats` 處理：用 `PropertiesService` 儲存最新一筆，不寫入 Sheets
   - `getDataPayload()` 讀取最新 stats，用 `c.owner`（容器名稱）對應 statsMap
   - GPU 整體值加入回傳 JSON（`gpuUtil` 欄位）

3. **`index.html`**
   - 頂部第四個 metric 卡片從「本週總工時」改為「GPU 使用率」
   - 容器卡片固定顯示 CPU / MEM / GPU 三欄

**Task Scheduler 設定：**
- 任務名稱：`Docker_Stats_Logger`
- 觸發：每天，重複間隔 1 分鐘，持續無限期
- 執行身分：SYSTEM
- 動作：`powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Public\docker_stats_webhook.ps1"`

### 2026-03-26：最近紀錄表格改為捲軸顯示

1. **`index.html`**
   - 最近紀錄區塊加入固定高度（約 10 筆）與垂直捲軸
   - 欄位標題固定在頂部，捲動時不消失
   - 顯示上限從 30 筆擴大為 200 筆

2. **`ssh_webhook.ps1`**
   - 還原為輕量版：由排程任務在 EventID=4 時觸發，送一次後結束，不再常駐

3. **`apps_script.js`**
   - 新增 `isThrottled()`：同一 `user+ip` 60 秒內重複送達直接擋下

4. **各容器 `/root/.bashrc`**
   - throttle 時間從 10 秒改為 60 秒

### 2026-03-25：初版上線

- SSH 登入觸發、容器進入通知、Telegram 通知、前端監控介面
