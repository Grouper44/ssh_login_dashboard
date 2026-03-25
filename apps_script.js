// 在原本的 doPost 裡，把 action 判斷區塊換成這個完整版

var TELEGRAM_TOKEN = "8461660022:AAHhNCNfF4sTvyRgUOpdF5b5zf2Kw9ZP57o";
var CHAT_ID = "7772677149";

function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var action    = e.parameter.action    || "login";
  var user      = e.parameter.user      || "Unknown User";
  var ip        = e.parameter.ip        || "Unknown IP";
  var timestamp = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd HH:mm:ss");

  // ── 登出紀錄 ──────────────────────────────────────
  if (action === "logout" || action === "container_logout") {
    var sheet = getOrCreateSheet(ss, "登出紀錄", ["時間","使用者","IP","類型"]);
    sheet.appendRow([timestamp, user, ip, action]);
    return ContentService.createTextOutput("OK");
  }

  // ── 心跳（不通知 Telegram，只記錄）──────────────
  if (action === "ssh_heartbeat" || action === "container_heartbeat") {
    var sheet = getOrCreateSheet(ss, "心跳紀錄", ["時間","使用者","IP","類型"]);
    sheet.appendRow([timestamp, user, ip, action]);
    return ContentService.createTextOutput("OK");
  }

  // ── 容器登入 ──────────────────────────────────────
  if (action === "container" || action === "container_login") {
    var sheet = getOrCreateSheet(ss, "容器進入紀錄", ["時間","使用者/容器名稱","IP/容器ID"]);
    if (isThrottled(sheet, user, ip, 60)) return ContentService.createTextOutput("THROTTLED");
    sheet.appendRow([timestamp, user, ip]);
    sendTelegram("🔹 🐳 <b>Docker 容器連線</b>\n<code>━━━━━━━━━━━━━━━━━━</code>\n👤 <b>容器：</b> " + user + "\n🆔 <b>ID：</b> " + ip + "\n⏰ <b>時間：</b> " + timestamp + "\n<code>━━━━━━━━━━━━━━━━━━</code>");
    return ContentService.createTextOutput("OK");
  }

  // ── SSH 登入（預設）──────────────────────────────
  var sheet = getOrCreateSheet(ss, "工作表1", ["時間","使用者","IP位置"]);
  if (isThrottled(sheet, user, ip, 60)) return ContentService.createTextOutput("THROTTLED");
  sheet.appendRow([timestamp, user, ip]);
  sendTelegram("🔸 🔐 <b>SSH 登入</b>\n<code>━━━━━━━━━━━━━━━━━━</code>\n👤 <b>使用者：</b> " + user + "\n🌐 <b>IP：</b> " + ip + "\n⏰ <b>時間：</b> " + timestamp + "\n<code>━━━━━━━━━━━━━━━━━━</code>");
  return ContentService.createTextOutput("OK");
}

// ── 工具函式 ──────────────────────────────────────────
function isThrottled(sheet, user, ip, seconds) {
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return false;
  var cutoff = new Date(Date.now() - seconds * 1000);
  // scan from newest (bottom) upward
  for (var i = data.length - 1; i >= 1; i--) {
    var rowTime = new Date(data[i][0]);
    if (rowTime < cutoff) break;
    if (String(data[i][1]).trim() === user && String(data[i][2]).trim() === ip) return true;
  }
  return false;
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function sendTelegram(message) {
  try {
    UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "HTML" })
    });
  } catch(e) { console.log("TG Error: " + e); }
}

// ── doGet 保持不變（給前端讀資料用）─────────────────
function doGet(e) {
  if (e.parameter.action === 'getData') {
    return ContentService
      .createTextOutput(JSON.stringify(getDataPayload()))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getDataPayload() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  function parseTime(val) {
    try { var d = new Date(val); if (!isNaN(d)) return Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd HH:mm:ss"); } catch(e) {}
    return String(val);
  }
  function isValidUser(user) {
    if (!user) return false;
    var s = String(user).trim();
    return s && s !== 'Unknown User' && s !== 'Unknown' &&
           s.indexOf('錯誤') < 0 && s.indexOf('Exception') < 0 &&
           s.indexOf('已連接終端') < 0 && s.indexOf('通知') < 0 &&
           s.indexOf('Test') < 0;
  }
  function sheetToLogs(sheetName, type) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return [];
    return sheet.getDataRange().getValues().slice(1)
      .filter(function(r){ return isValidUser(r[1]); })
      .map(function(r){ return { time: parseTime(r[0]), type: type, user: String(r[1]).trim(), ip: String(r[2]).trim() }; });
  }

  var ssh  = sheetToLogs('工作表1', 'ssh');
  var cont = sheetToLogs('容器進入紀錄', 'container');
  var logs = ssh.concat(cont).sort(function(a,b){ return b.time > a.time ? 1 : -1; });

  // ── 在線判斷 ──
  var logoutSheet = ss.getSheetByName("登出紀錄");

  // 建立每個使用者的最後登出時間（取最晚的一筆）
  var logoutByUser = {};   // user -> 最晚登出時間
  var logoutByKey  = {};   // user|ip -> 最晚登出時間
  if (logoutSheet) {
    logoutSheet.getDataRange().getValues().slice(1).forEach(function(r) {
      var u = String(r[1]).trim();
      var t = parseTime(r[0]);
      // 以 user|ip 配對
      var key = u + '|' + String(r[2]).trim();
      if (!logoutByKey[key] || t > logoutByKey[key]) logoutByKey[key] = t;
      // 以 user 為單位（容器名稱）
      if (!logoutByUser[u] || t > logoutByUser[u]) logoutByUser[u] = t;
    });
  }

  // 心跳：只有真正有 active session 的容器才會回報心跳
  var heartbeatSheet = ss.getSheetByName("心跳紀錄");
  var heartbeatMap = {};
  if (heartbeatSheet) {
    heartbeatSheet.getDataRange().getValues().slice(1).forEach(function(r) {
      var name = String(r[1]).trim();
      var t = parseTime(r[0]);
      if (!heartbeatMap[name] || t > heartbeatMap[name]) heartbeatMap[name] = t;
    });
  }

  var now = new Date();
  var seen = {};
  var online = [];

  logs.forEach(function(r) {
    if (seen[r.user]) return;
    var loginTime = new Date(r.time);

    // 容器：用 user（容器名稱）比對登出，因為 exec_die 也用容器名
    // SSH：用 user|ip 配對
    var logoutTime = null;
    if (r.type === 'container') {
      var t1 = logoutByUser[r.user] ? new Date(logoutByUser[r.user]) : null;
      var t2 = logoutByKey[r.user + '|' + r.ip] ? new Date(logoutByKey[r.user + '|' + r.ip]) : null;
      // 取較晚的那個
      if (t1 && t2) logoutTime = t1 > t2 ? t1 : t2;
      else logoutTime = t1 || t2;
    } else {
      logoutTime = logoutByKey[r.user + '|' + r.ip] ? new Date(logoutByKey[r.user + '|' + r.ip]) : null;
    }

    // 已登出 -> 跳過
    if (logoutTime && logoutTime > loginTime) return;

    // 心跳在 10 分鐘內 -> 判定在線（心跳現在只有真正有人用的容器才會送）
    var hb = heartbeatMap[r.user] ? new Date(heartbeatMap[r.user]) : null;
    var loginAge = (now - loginTime) / 60000;

    // SSH：登入 30 分鐘內或心跳 10 分鐘內
    // 容器：必須有心跳 10 分鐘內 或 登入 15 分鐘內且無登出
    var isOnline = false;
    if (r.type === 'ssh') {
      isOnline = (hb && (now - hb) / 60000 < 10) || loginAge < 30;
    } else {
      isOnline = (hb && (now - hb) / 60000 < 10) || loginAge < 15;
    }

    if (isOnline) {
      seen[r.user] = true;
      var mins = Math.round(loginAge);
      var duration = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
      online.push({ name: r.user, ip: r.ip, type: r.type, duration: duration });
    }
  });

  // ── 容器狀態 ──
  var containerMap = {};
  cont.forEach(function(r) {
    if (!containerMap[r.ip]) containerMap[r.ip] = { name: r.ip, owner: r.user, lastSeen: r.time, lastLogin: r.time };
    else if (r.time > containerMap[r.ip].lastSeen) {
      containerMap[r.ip].lastSeen  = r.time;
      containerMap[r.ip].owner     = r.user;
      containerMap[r.ip].lastLogin = r.time;
    }
  });

  // 容器登出：同時用容器名稱(owner)和容器ID(key)比對
  var logoutContainerByName = {};  // 容器名稱 -> 最晚登出時間
  var logoutContainerByID   = {};  // 容器ID -> 最晚登出時間
  if (logoutSheet) {
    logoutSheet.getDataRange().getValues().slice(1).forEach(function(r) {
      if (String(r[3]).indexOf('container') >= 0) {
        var u = String(r[1]).trim();
        var cid = String(r[2]).trim();
        var t = parseTime(r[0]);
        if (!logoutContainerByName[u] || t > logoutContainerByName[u]) logoutContainerByName[u] = t;
        if (!logoutContainerByID[cid] || t > logoutContainerByID[cid]) logoutContainerByID[cid] = t;
      }
    });
  }

  var containers = Object.keys(containerMap).map(function(k) {
    var c = containerMap[k];
    // 用容器名稱或容器ID找登出紀錄
    var lastLogout = null;
    var t1 = logoutContainerByName[c.owner] ? new Date(logoutContainerByName[c.owner]) : null;
    var t2 = logoutContainerByID[k] ? new Date(logoutContainerByID[k]) : null;
    if (t1 && t2) lastLogout = t1 > t2 ? t1 : t2;
    else lastLogout = t1 || t2;

    var lastLogin  = new Date(c.lastLogin);
    var diff = (now - new Date(c.lastSeen)) / 60000;

    // 心跳判斷：有心跳且在 10 分鐘內 → active
    var hb = heartbeatMap[c.owner] ? new Date(heartbeatMap[c.owner]) : null;
    var hbAge = hb ? (now - hb) / 60000 : 9999;

    var status;
    if (lastLogout && lastLogout > lastLogin) {
      // 有登出且在最後登入之後 → 看心跳是否又恢復
      if (hbAge < 10) {
        status = 'active';
      } else {
        status = 'stopped';
      }
    } else if (hbAge < 10 || diff < 15) {
      status = 'active';
    } else if (diff < 90) {
      status = 'idle';
    } else {
      status = 'stopped';
    }

    return { name: c.name, owner: c.owner, status: status, cpu: 0, mem: 0, gpu: 0 };
  });

  // ── 統計 ──
  var today = Utilities.formatDate(now, "GMT+8", "yyyy-MM-dd");
  var hourStats = new Array(24).fill(0);
  logs.forEach(function(r) {
    if (r.time.indexOf(today) === 0) {
      var h = parseInt(r.time.split(' ')[1].split(':')[0]);
      if (h >= 0 && h < 24) hourStats[h]++;
    }
  });

  var userCount = {};
  logs.forEach(function(r) {
    if (r.type === 'container') userCount[r.user] = (userCount[r.user] || 0) + 1;
  });
  var userSorted = Object.keys(userCount).sort(function(a,b){ return userCount[b]-userCount[a]; }).slice(0,8);
  var userStats = { labels: userSorted, data: userSorted.map(function(u){ return userCount[u]; }) };

  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var weekCount = [0,0,0,0,0,0,0];
  var weekLabels = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date(now); d.setDate(d.getDate() - i);
    var ds = Utilities.formatDate(d, "GMT+8", "yyyy-MM-dd");
    weekLabels.push(days[d.getDay()]);
    var idx = 6 - i;
    logs.forEach(function(r){ if (r.time.indexOf(ds) === 0) weekCount[idx]++; });
  }

  return {
    logs: logs,
    online: online,
    containers: containers,
    hourStats: hourStats,
    userStats: userStats,
    weekStats: { labels: weekLabels, data: weekCount }
  };
}
