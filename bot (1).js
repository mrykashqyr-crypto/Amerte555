/**
 * أميرتي v4 — bot.js
 * واتساب Baileys + Gemini 2.0 Flash
 * كود الأرقام يظهر على الموقع مباشرة
 */
'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const pino = require('pino');
const fs   = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const BOT_PHONE      = (process.env.BOT_PHONE || '').replace(/\D/g, '');
const BOT_NAME       = process.env.BOT_NAME || 'أميرتي';
const AUTH_DIR       = path.join(__dirname, 'bots', 'auth_info');

// ── Gemini 2.0 Flash ──────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: `أنت "${BOT_NAME}"، مساعدة ذكية على واتساب.
- ردودك قصيرة ومفيدة (3-4 جمل فقط)
- خاطب المستخدم باسمه دائماً
- لا تذكر أعذاراً تقنية أبداً
- رد بنفس لغة المستخدم`,
  generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
});

// ── State مشترك مع index.js ───────────────────────────────────
const state = {
  status:     'stopped',  // stopped | starting | pairing | online | reconnecting
  pairingCode: null,      // كود الأرقام يظهر على الموقع
  pairingExp:  null,      // وقت انتهاء الكود
  activeBot:  null,
  logs:       [],
};

function addLog(text, src = 'out') {
  const line = { ts: Date.now(), src, text: String(text).trim() };
  if (!line.text) return;
  state.logs.push(line);
  if (state.logs.length > 400) state.logs.shift();
  process.stdout.write(line.text + '\n');
}

function getState() { return state; }

// ── Chat memory ───────────────────────────────────────────────
const chatSessions = new Map();
const processedIds = new Set();

function getChat(jid) {
  if (!chatSessions.has(jid)) chatSessions.set(jid, model.startChat({ history: [] }));
  return chatSessions.get(jid);
}

// ── Bot ───────────────────────────────────────────────────────
let sock           = null;
let reconnectTimer = null;
let reconnectCount = 0;
let pairingDone    = false;

function scheduleReconnect(ms) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectCount++;
  const wait = ms ?? Math.min(5000 * reconnectCount, 30000);
  addLog(`[NET] إعادة الاتصال خلال ${Math.round(wait/1000)}s...`, 'sys');
  reconnectTimer = setTimeout(() => startBot(state.activeBot), wait);
}

async function startBot(botFile) {
  try {
    if (sock) { try { sock.end(undefined); } catch {} sock = null; }
    state.status      = 'starting';
    state.pairingCode = null;
    state.pairingExp  = null;
    pairingDone       = false;
    if (botFile) state.activeBot = botFile;

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try { const r = await fetchLatestBaileysVersion(); version = r.version; } catch {}

    sock = makeWASocket({
      version,
      auth:   authState,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory:       false,
      markOnlineOnConnect:   false,
      connectTimeoutMs:      90000,
      defaultQueryTimeoutMs: 90000,
      keepAliveIntervalMs:   30000,
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Connection update ─────────────────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

      // طلب كود الأرقام مرة واحدة
      if (!authState.creds.registered && connection === 'connecting' && !pairingDone) {
        pairingDone = true;
        try {
          if (!BOT_PHONE) {
            addLog('[ERR] أضف BOT_PHONE في متغيرات Render', 'err');
            return;
          }
          await new Promise(r => setTimeout(r, 3500));
          const code = await sock.requestPairingCode(BOT_PHONE);
          state.status      = 'pairing';
          state.pairingCode = code;
          state.pairingExp  = Date.now() + 60000; // ينتهي بعد 60 ثانية
          addLog(`[PAIRING] الكود: ${code}`, 'sys');
        } catch (e) {
          addLog('[ERR] فشل طلب الكود: ' + e.message, 'err');
          pairingDone = false;
        }
      }

      if (connection === 'open') {
        reconnectCount    = 0;
        pairingDone       = false;
        state.status      = 'online';
        state.pairingCode = null;
        state.pairingExp  = null;
        addLog(`[OK] ${BOT_NAME} متصلة ⚡ Gemini 2.0 Flash`, 'sys');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        addLog(`[CLOSE] انقطع — كود: ${code || '?'}`, 'sys');
        state.status      = 'reconnecting';
        state.pairingCode = null;
        pairingDone       = false;

        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          chatSessions.clear();
          addLog('[INFO] تم حذف الجلسة — سيطلب كود جديد', 'sys');
        }
        scheduleReconnect();
      }
    });

    // ── Messages ──────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          if (!msg?.message || processedIds.has(msg.key?.id)) continue;
          processedIds.add(msg.key?.id);
          if (processedIds.size > 300) processedIds.delete(processedIds.values().next().value);

          const jid = msg.key.remoteJid;
          if (!jid || jid === 'status@broadcast' || msg.key.fromMe) continue;

          const isGroup = jid.endsWith('@g.us');
          const body    =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption || '';

          if (!body.trim()) continue;
          const senderName = msg.pushName || 'صديقي';
          if (isGroup && !body.includes(BOT_NAME)) continue;

          addLog(`[MSG] ${senderName}: ${body}`, 'out');

          // أمر انسى
          if (body.replace(BOT_NAME, '').trim() === 'انسى') {
            chatSessions.delete(jid);
            await sock.sendMessage(jid, { text: '🧠 تم! نبدأ من جديد.' }, { quoted: msg });
            continue;
          }

          // ⚡ Gemini 2.0 Flash
          const chat   = getChat(jid);
          const result = await chat.sendMessage(`${senderName}: ${body}`);
          const reply  = result.response.text().trim();
          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            addLog(`[SENT] ⚡ رد على ${senderName}`, 'sys');
          }
        } catch (e) { addLog('[ERR] ' + e.message, 'err'); }
      }
    });

  } catch (e) {
    addLog('[ERR] startBot: ' + e.message, 'err');
    state.status = 'stopped';
    scheduleReconnect(8000);
  }
}

function stopBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (sock) { try { sock.end(undefined); } catch {} sock = null; }
  state.status      = 'stopped';
  state.pairingCode = null;
  pairingDone       = false;
  addLog('[PANEL] تم إيقاف البوت.', 'sys');
}

module.exports = { startBot, stopBot, getState };
