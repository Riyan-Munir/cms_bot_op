// src/utils/alertService.js
// Uses Resend API (free, 100 emails/day, works on any host including Railway)
// No SMTP — pure HTTPS so no port blocking or IP reputation issues.
//
// Setup (2 min):
//   1. Sign up at https://resend.com (free)
//   2. Go to API Keys → Create API Key → copy it
//   3. Add to Railway env vars:
//        RESEND_API_KEY=re_xxxxxxxx
//        ADMIN_EMAIL=you@gmail.com
//   Optional (WhatsApp DM for non-session alerts):
//        ADMIN_PHONE=923001234567

const https  = require('https');
const logger = require('./logger');

const lastSent = {};
const COOLDOWN = 10 * 60 * 1000;

function canSend(type) {
  const now = Date.now();
  if (lastSent[type] && now - lastSent[type] < COOLDOWN) return false;
  lastSent[type] = now;
  return true;
}

function sendEmail(subject, body) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.ADMIN_EMAIL;

  if (!apiKey || !to) {
    logger.warn('[Alert] Email skipped — RESEND_API_KEY or ADMIN_EMAIL not set.');
    return Promise.resolve(false);
  }

  const payload = JSON.stringify({
    from:    'CMS Bot <onboarding@resend.dev>',
    to:      [to],
    subject: `CMS Bot: ${subject}`,
    text:    `${body}\n\nTime: ${new Date().toISOString()}\nServer: ${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}`
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info(`[Alert] Email sent → ${to} | ${subject}`);
          resolve(true);
        } else {
          logger.error(`[Alert] Email failed — HTTP ${res.statusCode}: ${data}`);
          resolve(false);
        }
      });
    });
    req.on('error', (err) => {
      logger.error(`[Alert] Email request failed: ${err.message}`);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

async function sendWhatsAppDM(text) {
  const phone = process.env.ADMIN_PHONE;
  if (!phone) return false;
  try {
    const { isWhatsAppReady, sendDirectMessage } = require('../whatsapp/whatsappClient');
    if (!isWhatsAppReady()) { logger.warn('[Alert] WhatsApp DM skipped — session not ready.'); return false; }
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    await sendDirectMessage(chatId, text);
    logger.info(`[Alert] WhatsApp DM sent → ${phone}`);
    return true;
  } catch (err) {
    logger.error(`[Alert] WhatsApp DM failed: ${err.message}`);
    return false;
  }
}

async function dispatch(type, subject, message, emailOnly = false) {
  logger.info(`[Alert] Dispatching "${type}"...`);
  if (!canSend(type)) { logger.info(`[Alert] "${type}" suppressed (cooldown).`); return; }

  const waText = `🤖 *CMS Bot Alert*\n\n${message}\n\n⏰ ${new Date().toISOString()}`;
  if (!emailOnly) await sendWhatsAppDM(waText);
  await sendEmail(subject, message);
}

module.exports = {
  whatsappDisconnected: (reason) =>
    dispatch('wa_disconnected', 'WhatsApp Session Disconnected',
      `WhatsApp session disconnected.\n\nReason: ${reason}\n\nOpen /qr to re-authenticate:\nhttps://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:3000'}/qr`,
      true),

  whatsappAuthFailed: (msg) =>
    dispatch('wa_auth_fail', 'WhatsApp Auth Failed',
      `WhatsApp auth failed.\n\nError: ${msg}\n\nOpen /qr to re-scan:\nhttps://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:3000'}/qr`,
      true),

  qrRequired: () =>
    dispatch('qr_required', 'WhatsApp QR Scan Required',
      `WhatsApp session not found — QR scan needed.\n\nOpen /qr to link WhatsApp:\nhttps://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:3000'}/qr`,
      true),

  cmsLoginFailed: (err) =>
    dispatch('cms_login', 'CMS Login Failed',
      `CMS login failed.\n\nError: ${err}\n\nCheck CMS_ENROLLMENT and CMS_PASSWORD env vars.`),

  scrapeFailed: (err) =>
    dispatch('scrape_fail', 'CMS Scrape Failed',
      `CMS scrape failed.\n\nError: ${err}`),

  sendFailed: (type) =>
    dispatch('send_fail', `WhatsApp Group Send Failed (${type})`,
      `Failed to deliver ${type} notification to the group after all retries.\n\nStudents did NOT receive this message.`),
};