// src/whatsapp/whatsappClient.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const { EventEmitter }      = require('events');
const logger                = require('../utils/logger');
const path                  = require('path');
const fs                    = require('fs');
const { execSync }          = require('child_process');

const qrEventEmitter = new EventEmitter();
qrEventEmitter.setMaxListeners(20);

let client    = null;
let isReady   = false;
let latestQR  = null;
let latestRaw = null;

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.platform !== 'linux') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
    return undefined;
  }
  const linux = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  for (const p of linux) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  try { return execSync('which chromium-browser || which chromium || which google-chrome', { stdio: ['pipe','pipe','ignore'] }).toString().trim(); } catch (_) {}
  return undefined;
}

function buildPuppeteerConfig() {
  const isLinux        = process.platform === 'linux';
  const executablePath = findChrome();
  logger.info(`WA Browser: ${executablePath || 'puppeteer bundled'}`);
  return isLinux
    ? { headless: true, executablePath, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer','--disable-extensions','--no-zygote','--single-process','--js-flags=--max-old-space-size=256'] }
    : { headless: false, executablePath, args: ['--no-sandbox','--window-position=-10000,0'] };
}

async function initWhatsApp() {
  if (client && isReady) return client;

  isReady = false; latestQR = null; latestRaw = null;
  if (client) { try { await client.destroy(); } catch (_) {} client = null; }

  logger.info('Initializing WhatsApp...');

  const sessionPath = process.env.WHATSAPP_SESSION_PATH || path.join(__dirname, '../../data/whatsapp-session');

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: buildPuppeteerConfig(),
    restartOnAuthFail: true
  });

  client.on('qr', async (qr) => {
    logger.info('No saved session — QR required. Open /qr to scan.');
    latestRaw = qr; latestQR = null;
    try { require('qrcode-terminal').generate(qr, { small: true }); } catch (_) {}
    try {
      latestQR = await require('qrcode').toDataURL(qr, { errorCorrectionLevel: 'H', width: 400 });
      qrEventEmitter.emit('qr', latestQR);
    } catch (_) { qrEventEmitter.emit('qr_raw', qr); }
    require('../utils/alertService').qrRequired().catch(() => {});
  });

  client.on('authenticated', () => {
    logger.info('Session authenticated.');
    latestQR = null; latestRaw = null;
  });

  client.on('auth_failure', (m) => {
    logger.error(`Auth failed: ${m}`);
    isReady = false;
    require('../utils/alertService').whatsappAuthFailed(m).catch(() => {});
  });

  client.on('ready', () => {
    logger.info('✅ WhatsApp ready!');
    isReady = true; latestQR = null; latestRaw = null;
    qrEventEmitter.emit('ready');
  });

  client.on('disconnected', (r) => {
    logger.warn(`WhatsApp disconnected: ${r}`);
    isReady = false; client = null;
    qrEventEmitter.emit('disconnected');
    require('../utils/alertService').whatsappDisconnected(r).catch(() => {});
  });

  const ready = new Promise((res, rej) => {
    if (isReady) return res(client);
    client.once('ready',        ()  => res(client));
    client.once('auth_failure', (m) => rej(new Error(`Auth failed: ${m}`)));
    client.once('disconnected', (r) => rej(new Error(`Disconnected during init: ${r}`)));
  });

  await client.initialize();
  return ready;
}

// Detect dead browser frame errors that require a full client restart
function isFrameError(err) {
  const msg = err.message || '';
  return msg.includes('detached Frame')
    || msg.includes('detached frame')
    || msg.includes('Target closed')
    || msg.includes('Session closed')
    || msg.includes('Protocol error')
    || msg.includes('Cannot find context')
    || msg.includes('Execution context was destroyed');
}

// Full client restart — used by assignmentProcessor on frame errors
async function restartClient() {
  logger.warn('Restarting WhatsApp client due to dead frame...');
  isReady = false;
  if (client) { try { await client.destroy(); } catch (_) {} client = null; }
  await initWhatsApp();
  logger.info('✅ WhatsApp client restarted.');
}

async function resolveTarget() {
  const groupName = process.env.WHATSAPP_GROUP_NAME;
  const groupId   = process.env.WHATSAPP_GROUP_ID;
  const targetNum = process.env.WHATSAPP_TARGET_NUMBER;
  if (!groupName && !groupId && !targetNum)
    throw new Error('Set WHATSAPP_GROUP_NAME, WHATSAPP_GROUP_ID, or WHATSAPP_TARGET_NUMBER in .env');
  const chats = await client.getChats();
  if (groupName) {
    const match = chats.find(c => c.isGroup && c.name === groupName);
    if (!match) throw new Error(`Group "${groupName}" not found. Use GET /groups to list.`);
    return match.id._serialized;
  }
  if (groupId) {
    const match = chats.find(c => c.isGroup && c.id._serialized === groupId);
    if (!match) throw new Error(`Group ID "${groupId}" not found.`);
    return groupId;
  }
  return targetNum.includes('@') ? targetNum : `${targetNum}@c.us`;
}

async function sendMessage(text) {
  if (!client || !isReady) throw new Error('WhatsApp not ready.');
  const chatId = await resolveTarget();
  await client.sendMessage(chatId, text);
  logger.info('✉️  Message sent.');
}

async function sendDirectMessage(chatId, text) {
  if (!client || !isReady) throw new Error('WhatsApp not ready.');
  await client.sendMessage(chatId, text);
  logger.info(`✉️  DM sent to ${chatId}`);
}

async function listGroups() {
  if (!client || !isReady) throw new Error('WhatsApp not ready.');
  return (await client.getChats())
    .filter(c => c.isGroup)
    .map(c => ({ name: c.name, id: c.id._serialized, participants: c.participants?.length ?? '?' }));
}

const isWhatsAppReady   = () => isReady;
const getLatestQR       = () => latestQR;
const getLatestQRString = () => latestRaw;
const isQRPending       = () => (!!latestQR || !!latestRaw) && !isReady;

module.exports = { initWhatsApp, restartClient, isFrameError, sendMessage, sendDirectMessage, listGroups, isWhatsAppReady, getLatestQR, getLatestQRString, isQRPending, qrEventEmitter };
