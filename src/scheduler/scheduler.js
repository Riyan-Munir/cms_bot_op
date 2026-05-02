// src/scheduler/scheduler.js
const cron = require('node-cron');
const { scrapeAssignments, refreshSession } = require('../scraper/cmsScraper');
const { processAssignments }               = require('./assignmentProcessor');
const { isWhatsAppReady }                  = require('../whatsapp/whatsappClient');
const logger                               = require('../utils/logger');

let checkTask   = null;
let refreshTask = null;
let running     = false;
let refreshing  = false; // track refresh state here too to avoid double-guard confusion

// Wait for WhatsApp with a timeout — prevents infinite hang if WA never comes up
function waitForWhatsApp(timeoutMs = 5 * 60 * 1000) {
  if (isWhatsAppReady()) return Promise.resolve(true);
  logger.info('Waiting for WhatsApp... (open /qr to scan)');
  return new Promise(resolve => {
    const deadline = setTimeout(() => { clearInterval(poll); resolve(false); }, timeoutMs);
    const poll = setInterval(() => {
      if (isWhatsAppReady()) { clearInterval(poll); clearTimeout(deadline); resolve(true); }
    }, 5000);
  });
}

async function runCheck() {
  if (running) { logger.warn('Check already running — skipping.'); return; }
  if (refreshing) { logger.warn('Session refresh in progress — skipping check.'); return; }

  running = true;
  logger.info('── Assignment check started ──');
  try {
    const ready = await waitForWhatsApp();
    if (!ready) {
      logger.warn('WhatsApp not ready after 5min — skipping this cycle.');
      return;
    }
    const assignments = await scrapeAssignments();
    await processAssignments(assignments);
    logger.info(`── Check complete (${assignments.length} assignments) ──`);
  } catch (err) {
    logger.error(`Check failed: ${err.message}`);
  } finally {
    running = false;
  }
}

async function runRefresh() {
  if (refreshing) { logger.warn('Refresh already in progress.'); return; }
  if (running) {
    // Wait for current check to finish before refreshing
    logger.info('Check in progress — will refresh after it completes.');
    const wait = setInterval(() => {
      if (!running) { clearInterval(wait); runRefresh(); }
    }, 5000);
    return;
  }
  refreshing = true;
  logger.info('Scheduled session refresh.');
  try {
    await refreshSession();
  } catch (e) {
    logger.error(`Refresh error: ${e.message}`);
  } finally {
    refreshing = false;
  }
}

function startScheduler() {
  const checkMins    = parseInt(process.env.CHECK_INTERVAL_MINUTES || '30', 10);
  const refreshHours = parseInt(process.env.SESSION_REFRESH_HOURS  || '6',  10);

  logger.info(`Scheduler: check every ${checkMins}min, session refresh every ${refreshHours}hr`);

  checkTask   = cron.schedule(`*/${checkMins} * * * *`, runCheck);
  // Use interval-based refresh (relative to startup) instead of fixed clock hours
  refreshTask = cron.schedule(`0 */${refreshHours} * * *`, runRefresh);

  // First check 15s after startup — gives WhatsApp time to restore session
  setTimeout(runCheck, 15000);
}

function stopScheduler() {
  checkTask?.stop();
  refreshTask?.stop();
  checkTask = null; refreshTask = null;
  logger.info('Scheduler stopped.');
}

module.exports = { startScheduler, stopScheduler, triggerManualCheck: runCheck };
