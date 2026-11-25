/**
 * أميرتي v4 — index.js
 * HTTP Server + Panel + Bot Manager
 */
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { startBot, stopBot, getState } = require('./bot');

const PORT       = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'amirati2026';
const CLIENT_DIR = path.join(__dirname, 'client');
const BOTS_DIR   = path.join(__dirname, 'bots');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// ── Multipart parser ──────────────────────────────────────────
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=([^\s;]+)/);
  if (!bm) return cb(new Error('no boundary'));
  const boundary = '--' + bm[1];
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const files = [];
    let pos = 0;
    while (pos < buf.length) {
      const bs = buf.indexOf(boundary, pos);
      if (bs === -1) break;
      pos = bs + boundary.length;
      if (buf.slice(pos, pos + 2).toString() === '--') break;
      pos += 2;
      const he = buf.indexOf('\r\n\r\n', pos);
      if (he === -1) break;
      const headers = buf.slice(pos, he).toString();
      pos = he + 4;
      const nm = headers.match(/filename="([^"]+)"/);
      if (!nm) { pos++; continue; }
      const nb = buf.indexOf('\r\n' + boundary, pos);
      if (nb === -1) break;
      files.push({ filename: path.basename(nm[1]), data: buf.slice(pos, nb) });
      pos = nb + 2;
    }
    cb(null, files);
  });
  req.on('error', cb);
}

function readBody(req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch(e) { cb(e); } });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html':'text/html;charset=utf-8', '.css':'text/css', '.js':'application/javascript', '.png':'image/png' };

function serveStatic(res, fp) {
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url    = req.url.split('?')[0];
  const method = req.method;
  const qs     = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

  // State API
  if (method === 'GET' && url === '/api/state') {
    const st    = getState();
    const since = parseInt(qs.get('since') || '0', 10);
    const bots  = fs.readdirSync(BOTS_DIR)
      .filter(f => !fs.statSync(path.join(BOTS_DIR, f)).isDirectory())
      .map(f => ({ name: f, size: fs.statSync(path.join(BOTS_DIR, f)).size }));
    return json(res, 200, { ...st, bots, logs: st.logs.filter(l => l.ts > since) });
  }

  // Upload
  if (method === 'POST' && url === '/api/upload') {
    parseMultipart(req, (err, files) => {
      if (err || !files.length) return json(res, 400, { ok: false, error: 'لا توجد ملفات' });
      const allowed = ['.js', '.py', '.ts', '.sh'];
      const saved = [];
      for (const f of files) {
        if (!allowed.includes(path.extname(f.filename).toLowerCase())) continue;
        fs.writeFileSync(path.join(BOTS_DIR, f.filename), f.data);
        saved.push(f.filename);
      }
      if (!saved.length) return json(res, 400, { ok: false, error: 'نوع الملف غير مدعوم' });
      json(res, 200, { ok: true, uploaded: saved });
    });
    return;
  }

  // Delete bot file
  if (method === 'DELETE' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.replace('/api/bots/', ''));
    const fp   = path.join(BOTS_DIR, name);
    if (!fs.existsSync(fp)) return json(res, 404, { ok: false });
    fs.unlinkSync(fp);
    return json(res, 200, { ok: true });
  }

  // Actions
  if (method === 'POST' && url === '/api/action') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false });
      if (body.pass !== ADMIN_PASS) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });
      const { action, bot } = body;
      if (action === 'start') startBot(bot || null);
      if (action === 'stop')  stopBot();
      if (action === 'restart') { stopBot(); setTimeout(() => startBot(bot || null), 1500); }
      if (action === 'reset_session') {
        stopBot();
        const auth = path.join(BOTS_DIR, 'auth_info');
        fs.rmSync(auth, { recursive: true, force: true });
        setTimeout(() => startBot(bot || null), 1500);
      }
      json(res, 200, { ok: true });
    });
    return;
  }

  // Static
  if (method === 'GET') {
    const fp = url === '/' ? '/index.html' : url;
    return serveStatic(res, path.join(CLIENT_DIR, fp));
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`[SERVER] أميرتي v4 على المنفذ ${PORT}`);
  // تشغيل البوت تلقائياً عند بدء السيرفر
  startBot(null);
});
