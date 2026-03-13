const { io }   = require('socket.io-client');
const https     = require('https');
const http      = require('http');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const GITASIS_HOST = 'montblanc.gitasis.com';
const GITASIS_USER = process.env.GITASIS_USER || 'YOUR_USERNAME';
const GITASIS_PASS = process.env.GITASIS_PASS || 'YOUR_PASSWORD';
const WORKER_URL   = 'https://gitasis-proxy.sagokolokubilay-3517.workers.dev/update';
const SOCKET_PORT  = 5432;
// ─────────────────────────────────────────────────────────────────────────────

let cookieJar   = '';
let socketReady = false;
let lastUsers   = -1;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── 1. LOGIN ──────────────────────────────────────────────────────────────────
function login() {
  return new Promise((resolve, reject) => {
    const body = `kullanici_adi=${encodeURIComponent(GITASIS_USER)}&kullanici_sifre=${encodeURIComponent(GITASIS_PASS)}`;
    const opts = {
      hostname: GITASIS_HOST,
      path: '/vt/inc/db.login.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 GitasisBridge/2.0'
      }
    };
    const req = https.request(opts, res => {
      cookieJar = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (cookieJar || res.statusCode === 302) {
          log(`✅ Login OK | cookies: ${cookieJar.substring(0, 80)}...`);
          resolve(cookieJar);
        } else {
          try {
            const j = JSON.parse(data);
            if (j.durum === 'ok' || j.status === 'ok') { resolve(cookieJar); return; }
          } catch(_) {}
          reject(new Error('Login failed: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 2. PUSH TO WORKER ─────────────────────────────────────────────────────────
function pushToWorker(payload) {
  const body = JSON.stringify(payload);
  const url  = new URL(WORKER_URL);
  const req  = https.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => { res.resume(); });
  req.on('error', e => log(`⚠️ Worker push error: ${e.message}`));
  req.write(body);
  req.end();
}

// ── 3. SOCKET.IO CLIENT ───────────────────────────────────────────────────────
function connectSocket() {
  log('🔌 Connecting to Gitasis socket.io...');

  const socket = io(`wss://${GITASIS_HOST}:${SOCKET_PORT}`, {
    transports: ['websocket'],
    extraHeaders: { Cookie: cookieJar },
    rejectUnauthorized: false,
    reconnection: true,
    reconnectionDelay: 10000,
    reconnectionAttempts: Infinity
  });

  socket.on('connect', () => {
    socketReady = true;
    log(`✅ Socket connected! id=${socket.id}`);
  });

  socket.on('connect_error', (e) => {
    socketReady = false;
    log(`❌ connect_error: ${e.message}`);
  });

  socket.on('disconnect', (reason) => {
    socketReady = false;
    log(`🔴 disconnect: ${reason}`);
  });

  socket.on('canli_ekran_user_list_sonuc', (data) => {
    const count = Array.isArray(data) ? data.length : '?';
    if (count !== lastUsers) { lastUsers = count; log(`👥 Users: ${count}`); }
    pushToWorker({ users: data });
  });

  socket.on('canli_ekran_info_list_sonuc', (data) => {
    const calls = data && data.call_online_list ? data.call_online_list : [];
    log(`📞 Calls: ${calls.length}`);
    pushToWorker({ calls });
  });

  return socket;
}

// ── 4. HTTP HEALTH SERVER ─────────────────────────────────────────────────────
function startHttpServer() {
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', socket: socketReady, uptime: Math.floor(process.uptime()), lastUsers }));
  }).listen(port, () => log(`🌐 Health server on :${port}`));
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  try {
    await login();
    connectSocket();
    // Re-login + reconnect every 6 hours
    setInterval(async () => {
      log('🔄 Refreshing session...');
      try { await login(); } catch(e) { log(`⚠️ Re-login: ${e.message}`); }
    }, 6 * 60 * 60 * 1000);
  } catch(e) {
    log(`❌ Startup error: ${e.message}`);
    setTimeout(main, 15000);
  }
}

startHttpServer();
main();
