const https = require('https');
const http = require('http');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const GITASIS_HOST   = 'montblanc.gitasis.com';
const GITASIS_USER   = process.env.GITASIS_USER   || 'YOUR_USERNAME';
const GITASIS_PASS   = process.env.GITASIS_PASS   || 'YOUR_PASSWORD';
const WORKER_URL     = 'https://gitasis-proxy.sagokolokubilay-3517.workers.dev/update';
const SOCKET_PORT    = 5432;
const RECONNECT_MS   = 10000;
// ────────────────────────────────────────────────────────────────────────────

let cookieJar = '';
let socketConnected = false;
let lastUserCount = -1;
let reconnectTimer = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── 1. LOGIN ─────────────────────────────────────────────────────────────────
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
        'User-Agent': 'Mozilla/5.0 GitasisBridge/1.0'
      }
    };
    const req = https.request(opts, res => {
      const cookies = res.headers['set-cookie'] || [];
      cookieJar = cookies.map(c => c.split(';')[0]).join('; ');
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.durum === 'ok' || json.status === 'ok') {
            log(`✅ Login OK | cookie: ${cookieJar.substring(0, 60)}...`);
            resolve(cookieJar);
          } else {
            reject(new Error('Login failed: ' + data));
          }
        } catch(e) {
          // Some versions return redirect instead of JSON
          if (res.statusCode === 302 || cookies.length > 0) {
            log(`✅ Login OK (redirect) | cookies: ${cookies.length}`);
            resolve(cookieJar);
          } else {
            reject(new Error('Login parse error: ' + data.substring(0, 200)));
          }
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 2. PUSH TO WORKER ────────────────────────────────────────────────────────
function pushToWorker(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url = new URL(WORKER_URL);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', e => log(`⚠️  Worker push error: ${e.message}`));
    req.write(body);
    req.end();
  });
}

// ── 3. SOCKET.IO CONNECTION ──────────────────────────────────────────────────
// We implement Socket.IO v2 handshake manually (no npm needed)
function connectSocket() {
  if (socketConnected) return;
  log('🔌 Connecting to Gitasis socket...');

  // Step 1: Engine.IO handshake
  const handshakePath = `/socket.io/?EIO=3&transport=polling&t=${Date.now()}`;
  const opts = {
    hostname: GITASIS_HOST,
    port: SOCKET_PORT,
    path: handshakePath,
    method: 'GET',
    headers: {
      'Cookie': cookieJar,
      'User-Agent': 'Mozilla/5.0 GitasisBridge/1.0'
    },
    rejectUnauthorized: false
  };

  const req = https.request(opts, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      // Parse EIO handshake: starts with digit+json
      const match = data.match(/\d+(\{.*\})/);
      if (!match) {
        log(`❌ Handshake failed: ${data.substring(0, 200)}`);
        scheduleReconnect();
        return;
      }
      try {
        const hs = JSON.parse(match[1]);
        log(`✅ EIO handshake OK | sid: ${hs.sid}`);
        startWebSocket(hs.sid);
      } catch(e) {
        log(`❌ Handshake parse error: ${e.message}`);
        scheduleReconnect();
      }
    });
  });
  req.on('error', e => {
    log(`❌ Handshake error: ${e.message}`);
    scheduleReconnect();
  });
  req.end();
}

function startWebSocket(sid) {
  const { WebSocket } = require('ws');
  const wsUrl = `wss://${GITASIS_HOST}:${SOCKET_PORT}/socket.io/?EIO=3&transport=websocket&sid=${sid}`;
  log(`🔌 WS connecting: ${wsUrl.substring(0, 80)}...`);

  const ws = new WebSocket(wsUrl, {
    headers: { 'Cookie': cookieJar },
    rejectUnauthorized: false
  });

  ws.on('open', () => {
    socketConnected = true;
    log('✅ WebSocket connected!');
    // Send upgrade probe
    ws.send('2probe');
  });

  ws.on('message', (raw) => {
    const msg = raw.toString();

    // Pong/ping
    if (msg === '3probe') { ws.send('5'); return; }
    if (msg === '2')       { ws.send('3'); return; } // heartbeat pong

    // Socket.IO packets start with 4 (message type)
    if (msg.startsWith('42')) {
      try {
        const payload = JSON.parse(msg.slice(2));
        const event = payload[0];
        const data  = payload[1];

        if (event === 'canli_ekran_user_list_sonuc') {
          const count = Array.isArray(data) ? data.length : '?';
          if (count !== lastUserCount) {
            lastUserCount = count;
            log(`👥 Users update: ${count}`);
          }
          pushToWorker({ users: data });
        }
        else if (event === 'canli_ekran_info_list_sonuc') {
          const calls = data && data.call_online_list ? data.call_online_list : [];
          log(`📞 Calls update: ${calls.length}`);
          pushToWorker({ calls });
        }
      } catch(e) {
        // ignore parse errors
      }
    }
  });

  ws.on('close', (code, reason) => {
    socketConnected = false;
    log(`🔴 WS closed: ${code} ${reason}`);
    scheduleReconnect();
  });

  ws.on('error', (e) => {
    socketConnected = false;
    log(`❌ WS error: ${e.message}`);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  log(`⏳ Reconnecting in ${RECONNECT_MS/1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    main();
  }, RECONNECT_MS);
}

// ── 4. KEEP-ALIVE HTTP SERVER (for Railway/Render free tier) ─────────────────
function startHttpServer() {
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      status: 'ok',
      socket: socketConnected,
      uptime: Math.floor(process.uptime()),
      lastUsers: lastUserCount
    }));
  }).listen(port, () => log(`🌐 HTTP server on port ${port}`));
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (!cookieJar) {
      await login();
    }
    connectSocket();
  } catch(e) {
    log(`❌ main() error: ${e.message}`);
    scheduleReconnect();
  }
}

startHttpServer();
main();

// Re-login every 6 hours in case session expires
setInterval(async () => {
  log('🔄 Refreshing session...');
  cookieJar = '';
  try { await login(); } catch(e) { log(`⚠️ Re-login failed: ${e.message}`); }
}, 6 * 60 * 60 * 1000);
