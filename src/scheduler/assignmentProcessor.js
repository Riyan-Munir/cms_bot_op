// src/scheduler/assignmentProcessor.js
const store                          = require('../utils/notificationStore');
const { sendMessage, restartClient,
        isFrameError }               = require('../whatsapp/whatsappClient');
const { closeBrowser }               = require('../scraper/cmsScraper');
const messages                       = require('../whatsapp/messages');
const alerts                         = require('../utils/alertService');
const logger                         = require('../utils/logger');

const H48   = 48 * 3600000;
const H6    =  6 * 3600000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function processAssignments(assignments) {
  const now = Date.now();

  const batch48    = [];
  const batch6     = [];
  const extensions = [];

  for (const a of assignments) {
    const { courseName, title, deadline: deadlineDisplay, deadlineMs } = a;
    if (!deadlineMs) { logger.warn(`No deadline parsed for "${title}".`); continue; }

    const { record, deadlineChanged } = store.upsertRecord(courseName, title, deadlineDisplay, deadlineMs);
    if (deadlineMs < now) continue;

    const remaining   = deadlineMs - now;
    const isSudden    = remaining <= 24 * 3600000;
    const isExtension = record.isExtension || false;

    if (deadlineChanged && !record.extensionNotified)
      extensions.push({ courseName, title, deadlineDisplay });

    if (remaining <= H6) {
      // Within 6hr — silently mark 48hr done, only send 6hr alert
      if (!record.alert48hrSent) {
        store.markFlags(courseName, title, { alert48hrSent: true });
        record.alert48hrSent = true;
      }
      if (!record.alert6hrSent)
        batch6.push({ courseName, title, deadlineDisplay, isExtension });
    } else if (remaining <= H48) {
      if (!record.alert48hrSent)
        batch48.push({ courseName, title, deadlineDisplay, isSudden, isExtension });
    }
  }

  const totalPending = extensions.length + (batch48.length > 0 ? 1 : 0) + (batch6.length > 0 ? 1 : 0);

  if (totalPending === 0) {
    logger.info('No notifications to send.');
    store.cleanupExpired();
    return;
  }

  // Close scraper browser first — frees memory for WhatsApp browser on Railway
  logger.info(`Closing scraper browser, freeing memory before sends...`);
  await closeBrowser();
  await sleep(4000);

  for (const { courseName, title, deadlineDisplay } of extensions) {
    logger.info(`Sending extension alert: "${title}"`);
    const sent = await safeSend(messages.alertExtended({ courseName, title, deadlineDisplay }));
    if (sent) store.markFlags(courseName, title, { extensionNotified: true });
    else logger.error(`Extension alert failed for "${title}" — will retry next cycle.`);
    await sleep(3000);
  }

  if (batch48.length > 0) {
    logger.info(`Sending 48hr batch: ${batch48.length} assignment(s).`);
    const sent = await safeSend(messages.alert48hrBatch(batch48));
    if (sent) {
      for (const { courseName, title } of batch48)
        store.markFlags(courseName, title, { alert48hrSent: true });
      logger.info('48hr batch sent.');
    } else {
      alerts.sendFailed('48hr').catch(() => {});
      logger.error('48hr batch failed — will retry next cycle.');
    }
    await sleep(3000);
  }

  if (batch6.length > 0) {
    logger.info(`Sending 6hr batch: ${batch6.length} assignment(s).`);
    const sent = await safeSend(messages.alert6hrBatch(batch6));
    if (sent) {
      for (const { courseName, title } of batch6)
        store.markFlags(courseName, title, { alert6hrSent: true });
      logger.info('6hr batch sent.');
    } else {
      alerts.sendFailed('6hr').catch(() => {});
      logger.error('6hr batch failed — will retry next cycle.');
    }
  }

  store.cleanupExpired();
}

// Smart retry: on frame error, restart the WA client then retry immediately
async function safeSend(text, retries = 5, delay = 8000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await sendMessage(text);
      return true;
    } catch (err) {
      logger.error(`Send attempt ${i}/${retries} failed: ${err.message}`);
      if (isFrameError(err)) {
        logger.warn('Dead frame — restarting WhatsApp client...');
        try {
          await restartClient();
          await sleep(3000);
          continue; // retry with fresh client, skip delay
        } catch (e) {
          logger.error(`Client restart failed: ${e.message}`);
          return false;
        }
      }
      if (i < retries) await sleep(delay);
    }
  }
  return false;
}

module.exports = { processAssignments };
