// src/utils/notificationStore.js
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const STORE_PATH = path.join(__dirname, '../../data/notifications.json');

const key = (course, title) => `${course.trim()}::${title.trim()}`;

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (_) { return {}; }
}

function save(store) {
  try { fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); }
  catch (e) { logger.error(`Store save: ${e.message}`); }
}

function upsertRecord(courseName, title, deadlineDisplay, deadlineMs) {
  const store = load();
  const k     = key(courseName, title);
  const now   = new Date().toISOString();
  let deadlineChanged = false;

  if (store[k]) {
    if (store[k].deadlineMs !== deadlineMs) {
      deadlineChanged = true;
      logger.info(`Deadline changed for "${title}": ${store[k].deadlineDisplay} → ${deadlineDisplay}`);
      store[k] = { ...store[k], deadlineDisplay, deadlineMs, alert48hrSent: false, alert6hrSent: false, extensionNotified: false, isExtension: true, updatedAt: now };
    }
  } else {
    store[k] = { courseName, title, deadlineDisplay, deadlineMs, alert48hrSent: false, alert6hrSent: false, extensionNotified: false, isExtension: false, createdAt: now, updatedAt: now };
  }

  save(store);
  return { record: store[k], deadlineChanged };
}

function markFlags(courseName, title, flags) {
  const store = load();
  const k = key(courseName, title);
  if (store[k]) { Object.assign(store[k], flags, { updatedAt: new Date().toISOString() }); save(store); }
}

// Update a full record by key — used by /notifications editor
function updateRecord(k, data) {
  const store = load();
  if (!store[k]) return false;
  store[k] = { ...store[k], ...data, updatedAt: new Date().toISOString() };
  save(store);
  return true;
}

// Delete a record by key — used by /notifications editor
function deleteRecord(k) {
  const store = load();
  if (!store[k]) return false;
  delete store[k];
  save(store);
  return true;
}

function getAllRecords() { return load(); }

function cleanupExpired() {
  const store  = load();
  const now    = Date.now();
  let removed  = 0;
  for (const k of Object.keys(store)) {
    const { deadlineMs, alert48hrSent, alert6hrSent } = store[k];
    if (!deadlineMs) continue;
    const pastDeadline = now > deadlineMs;
    const allSent      = alert48hrSent && alert6hrSent;
    const longPast     = now - deadlineMs > 2 * 24 * 3600000;
    if (pastDeadline && (allSent || longPast)) { delete store[k]; removed++; }
  }
  if (removed) { save(store); logger.info(`Removed ${removed} expired assignment(s).`); }
}

module.exports = { upsertRecord, markFlags, updateRecord, deleteRecord, getAllRecords, cleanupExpired };