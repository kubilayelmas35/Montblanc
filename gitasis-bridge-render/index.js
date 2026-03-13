const { createHash } = require('crypto');
const { WebSocket }  = require('ws');
const https          = require('https');
const http           = require('http');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const GITASIS_HOST = 'montblanc.gitasis.com';
const GITASIS_PORT = 5432;
const GITASIS_USER = process.env.GITASIS_USER || 'YOUR_USERNAME';
const GITASIS_PASS = process.env.GITASIS_PASS || 'YOUR_PASSWORD';
const WORKER_URL   = 'https://gitasis-proxy.sagokolokubilay-3517.workers.dev/update';
const RECONNECT_MS = 15000;
// ─────────────────────────────────────────────────────────────────────────────

let cookieJar  = '';
let uid        = null;
let wsConn     = null;
let connected  = false;
let lastUsers  = -1;
let pingTimer  = null;
let reconnTimer = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sha256(str) {
  return createHash('sha256').update(str).digest('hex').toUpperCase();
}

// ── 1. LOGIN ──────────────────────────────────────────────────────────────────
function login() {
  return new Promise((resolve, reject) => {
    const body = `act=login&kullanici_adi=${encodeURIComponent(GITASIS_USER)}&kullanici_sifre=${encodeURIComponent(GITASIS_PASS)}`;
    const opts = {
      hostname: GITASIS_HOST,
      path: '/vt/inc/db.login.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      }
    };

    let redirectCookie = '';
    const req = https.request(opts, res => {
      const cookies = res.headers['set-cookie'] || [];
      if (cookies.length) {
        cookieJar = cookies.map(c => c.split(';')[0]).join('; ');
        redirectCookie = cookieJar;
      }

      // Follow redirect if needed
      if (res.statusCode === 302 && res.headers.location) {
        log(`↩️  Redirect to: ${res.headers.location}`);
        res.resume();
        // Follow the redirect
        const redir = new URL(res.headers.location, `https://${GITASIS_HOST}`);
        const r2 = https.request({
          hostname: redir.hostname,
          path: redir.pathname + redir.search,
          method: 'GET',
          headers: { 'Cookie': cookieJar, 'User-Agent': 'Mozilla/5.0' }
        }, r2res => {
          const c2 = r2res.headers['set-cookie'] || [];
          if (c2.length) cookieJar += '; ' + c2.map(c => c.split(';')[0]).join('; ');
          r2res.resume();
          r2res.on('end', () => {
            log(`✅ Login OK (redirect followed) | cookie len: ${cookieJar.length}`);
            resolve(cookieJar);
          });
        });
        r2.on('error', reject);
        r2.end();
        return;
      }

      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        // Strip PHP warnings
        const clean = data.replace(/<br[^>]*>[\s\S]*?(?=\{|$)/g, '').trim();
        try {
          const json = JSON.parse(clean);
          if (json.status === 'ok' || json.durum === 'ok') {
            // Server may return uid
            if (json.uid) uid = json.uid;
            log(`✅ Login OK (JSON) uid=${uid}`);
            resolve(cookieJar);
          } else if (json.status === 'err') {
            reject(new Error('Login error: ' + (json.msg || data)));
          } else {
            // Might be logged in anyway if we have cookies
            if (cookieJar) { log('✅ Login OK (cookie)'); resolve(cookieJar); }
            else reject(new Error('Login unknown: ' + clean.substring(0, 200)));
          }
        } catch(_) {
          if (cookieJar) { log('✅ Login OK (cookie, no JSON)'); resolve(cookieJar); }
          else reject(new Error('Login parse fail: ' + clean.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 2. GET UID (if not from login) ───────────────────────────────────────────
function getUid() {
  if (uid) return Promise.resolve(uid);
  return new Promise((resolve, reject) => {
    // Fetch index.php and extract uid from page or a user-info endpoint
    const req = https.request({
      hostname: GITASIS_HOST,
      path: '/index.php',
      method: 'GET',
      headers: { 'Cookie': cookieJar, 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        // Try to extract uid from page source
        const m = data.match(/["']uid["']\s*:\s*(\d+)/);
        if (m) { uid = parseInt(m[1]); log(`👤 uid extracted: ${uid}`); resolve(uid); }
        else { log('⚠️ uid not found in page, using default'); uid = 0; resolve(0); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 3. PUSH TO WORKER ─────────────────────────────────────────────────────────
function pushToWorker(payload) {
  const body = JSON.stringify(payload);
  const url  = new URL(WORKER_URL);
  const req  = https.request({
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => { res.resume(); });
  req.on('error', e => log(`⚠️ Worker: ${e.message}`));
  req.write(body); req.end();
}

// ── 4. HANDLE SOCKET.IO MESSAGE ───────────────────────────────────────────────
function handleMessage(msg) {
  // Engine.IO heartbeat
  if (msg === '2') { wsConn && wsConn.send('3'); return; }
  if (msg === '3') return; // pong

  // Socket.IO message packet: starts with 42
  if (msg.startsWith('42')) {
    try {
      const payload = JSON.parse(msg.slice(2));
      const event   = payload[0];
      const data    = payload[1];

      if (event === 'canli_ekran_user_list_sonuc') {
        const count = Array.isArray(data) ? data.length : '?';
        if (count !== lastUsers) { lastUsers = count; log(`👥 Users: ${count}`); }
        pushToWorker({ users: data });
      }
      else if (event === 'canli_ekran_info_list_sonuc') {
        const calls = (data && data.call_online_list) ? data.call_online_list : [];
        log(`📞 Calls: ${calls.length}`);
        pushToWorker({ calls });
      }
    } catch(_) {}
  }
}

// ── 5. CONNECT WEBSOCKET ──────────────────────────────────────────────────────
function connectSocket() {
  if (wsConn) { try { wsConn.terminate(); } catch(_) {} }
  connected = false;

  const up = sha256(GITASIS_PASS);
  const query = [
    `uid=${uid || 0}`,
    `un=${encodeURIComponent(GITASIS_USER)}`,
    `up=${up}`,
    `os=Windows`,
    `os_v=10`,
    `tarayici=Chrome`,
    `tarayici_v=120.0.0.0`,
    `EIO=4`,
    `transport=websocket`
  ].join('&');

  const wsUrl = `wss://${GITASIS_HOST}:${GITASIS_PORT}/socket.io/?${query}`;
  log(`🔌 WS connecting (uid=${uid})...`);

  const ws = new WebSocket(wsUrl, {
    headers: { Cookie: cookieJar },
    rejectUnauthorized: false
  });

  wsConn = ws;

  ws.on('open', () => {
    connected = true;
    log('✅ WebSocket open! Sending upgrade...');
    ws.send('2probe');
    // Ping every 25s
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('3');
    }, 25000);
  });

  ws.on('message', raw => {
    const msg = raw.toString();
    if (msg === '3probe') { ws.send('5'); log('✅ Socket.IO connected!'); return; }
    handleMessage(msg);
  });

  ws.on('close', (code, reason) => {
    connected = false;
    clearInterval(pingTimer);
    log(`🔴 WS closed: ${code} ${reason.toString().substring(0,100)}`);
    scheduleReconnect();
  });

  ws.on('error', e => {
    connected = false;
    log(`❌ WS error: ${e.message}`);
  });
}

function scheduleReconnect() {
  if (reconnTimer) return;
  log(`⏳ Reconnect in ${RECONNECT_MS / 1000}s...`);
  reconnTimer = setTimeout(() => {
    reconnTimer = null;
    connectSocket();
  }, RECONNECT_MS);
}

// ── 6. HTTP HEALTH SERVER ─────────────────────────────────────────────────────
function startHttpServer() {
  const port = process.env.PORT || 3000;
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected, uptime: Math.floor(process.uptime()), lastUsers }));
  }).listen(port, () => log(`🌐 Health on :${port}`));
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  try {
    await login();
    await getUid();
    connectSocket();
    // Re-login every 6h
    setInterval(async () => {
      log('🔄 Session refresh...');
      cookieJar = ''; uid = null;
      try { await login(); await getUid(); } catch(e) { log(`⚠️ Re-login: ${e.message}`); }
    }, 6 * 60 * 60 * 1000);
  } catch(e) {
    log(`❌ Startup: ${e.message}`);
    setTimeout(main, 20000);
  }
}

startHttpServer();
main();
