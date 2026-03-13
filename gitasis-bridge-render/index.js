const { createHash } = require('crypto');
const { WebSocket }  = require('ws');
const https          = require('https');
const http           = require('http');

const GITASIS_HOST = 'montblanc.gitasis.com';
const GITASIS_PORT = 5432;
const GITASIS_USER = process.env.GITASIS_USER || 'YOUR_USERNAME';
const GITASIS_PASS = process.env.GITASIS_PASS || 'YOUR_PASSWORD';
const GITASIS_UID  = process.env.GITASIS_UID  || '0';
const GITASIS_UP   = process.env.GITASIS_UP   || '';
const WORKER_URL   = 'https://gitasis-proxy.sagokolokubilay-3517.workers.dev/update';
const RECONNECT_MS = 15000;

let cookieJar = '', wsConn = null, connected = false, lastUsers = -1, pingTimer = null, reconnTimer = null;

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }
function sha256(str) { return createHash('sha256').update(str).digest('hex').toUpperCase(); }

function login() {
  return new Promise((resolve, reject) => {
    const body = 'kullanici_adi=' + encodeURIComponent(GITASIS_USER) + '&kullanici_sifre=' + encodeURIComponent(GITASIS_PASS);
    const req = https.request({ hostname: GITASIS_HOST, path: '/vt/inc/db.login.php', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      const cookies = res.headers['set-cookie'] || [];
      if (cookies.length) cookieJar = cookies.map(c => c.split(';')[0]).join('; ');
      if (res.statusCode === 302 && res.headers.location) {
        res.resume();
        const redir = new URL(res.headers.location, 'https://' + GITASIS_HOST);
        const r2 = https.request({ hostname: redir.hostname, path: redir.pathname + redir.search, method: 'GET', headers: { Cookie: cookieJar } }, r2res => {
          const c2 = r2res.headers['set-cookie'] || [];
          if (c2.length) cookieJar += '; ' + c2.map(c => c.split(';')[0]).join('; ');
          r2res.resume(); r2res.on('end', () => { log('Login OK (redirect)'); resolve(cookieJar); });
        });
        r2.on('error', reject); r2.end(); return;
      }
      let data = ''; res.on('data', d => data += d);
      res.on('end', () => { if (cookieJar) { log('Login OK (cookie)'); resolve(cookieJar); } else reject(new Error('Login failed: ' + data.substring(0, 200))); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function pushToWorker(payload) {
  const body = JSON.stringify(payload);
  const url = new URL(WORKER_URL);
  const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => { res.resume(); });
  req.on('error', e => log('Worker error: ' + e.message));
  req.write(body); req.end();
}

function handleMessage(msg) {
  if (msg === '2') { wsConn && wsConn.send('3'); return; }
  if (msg === '3') return;
  if (msg.startsWith('42')) {
    try {
      const p = JSON.parse(msg.slice(2)), event = p[0], data = p[1];
      if (event === 'canli_ekran_user_list_sonuc') {
        const count = Array.isArray(data) ? data.length : '?';
        if (count !== lastUsers) { lastUsers = count; log('Users: ' + count); }
        pushToWorker({ users: data });
      } else if (event === 'canli_ekran_info_list_sonuc') {
        const calls = (data && data.call_online_list) ? data.call_online_list : [];
        log('Calls: ' + calls.length); pushToWorker({ calls });
      }
    } catch(_) {}
  }
}

function connectSocket() {
  if (wsConn) { try { wsConn.terminate(); } catch(_) {} }
  connected = false;
  const up = GITASIS_UP || sha256(GITASIS_PASS);
  const uid = GITASIS_UID;
  const query = 'uid=' + uid + '&un=' + encodeURIComponent(GITASIS_USER) + '&up=' + up +
    '&os=Windows&os_v=10&tarayici=Chrome&tarayici_v=120.0.0.0&EIO=4&transport=websocket';
  const wsUrl = 'wss://' + GITASIS_HOST + ':' + GITASIS_PORT + '/socket.io/?' + query;
  log('WS connecting (uid=' + uid + ')...');
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookieJar }, rejectUnauthorized: false });
  wsConn = ws;
  ws.on('open', () => {
    connected = true;
    log('WebSocket open! EIO4 ready (no probe)');
    pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('3'); }, 25000);
  });
  ws.on('message', raw => {
    const msg = raw.toString();
    if (msg.startsWith('0')) { log('EIO4 handshake OK!'); return; }
    handleMessage(msg);
  });
  ws.on('close', (code, reason) => {
    connected = false; clearInterval(pingTimer);
    log('WS closed: ' + code + ' ' + reason.toString().substring(0, 80));
    scheduleReconnect();
  });
  ws.on('error', e => { connected = false; log('WS error: ' + e.message); });
}

function scheduleReconnect() {
  if (reconnTimer) return;
  log('Reconnect in ' + (RECONNECT_MS / 1000) + 's...');
  reconnTimer = setTimeout(() => { reconnTimer = null; connectSocket(); }, RECONNECT_MS);
}

function startHttpServer() {
  const port = process.env.PORT || 3000;
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connected, uptime: Math.floor(process.uptime()), lastUsers }));
  }).listen(port, () => log('Health on :' + port));
}

async function main() {
  try {
    await login(); connectSocket();
    setInterval(async () => { log('Session refresh...'); cookieJar = ''; try { await login(); } catch(e) { log('Re-login: ' + e.message); } }, 6 * 60 * 60 * 1000);
  } catch(e) { log('Startup: ' + e.message); setTimeout(main, 20000); }
}

startHttpServer();
main();
