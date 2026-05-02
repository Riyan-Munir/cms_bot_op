// src/scraper/cmsScraper.js
const puppeteer    = require('puppeteer');
const logger       = require('../utils/logger');
const alerts       = require('../utils/alertService');
const fs           = require('fs');
const { execSync } = require('child_process');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LOGIN_URL   = 'https://cms.bahria.edu.pk/Logins/Student/Login.aspx';
const PROFILE_URL = 'https://cms.bahria.edu.pk/Sys/Student/Profile.aspx';
const GOTO_LMS    = 'https://cms.bahria.edu.pk/Sys/Common/GoToLMS.aspx';

// Pakistan Standard Time = UTC+5 (no DST)
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

let browser      = null;
let page         = null;
let lmsBase      = null;
let isRefreshing = false;

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

function getLaunchOptions() {
  const executablePath = findChrome();
  logger.info(`Scraper browser: ${executablePath || 'puppeteer bundled'}`);
  return process.platform === 'linux'
    ? { headless: true, executablePath, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer','--disable-extensions','--no-zygote','--single-process','--js-flags=--max-old-space-size=256'] }
    : { headless: true, executablePath, args: ['--no-sandbox'] };
}

async function destroyBrowser() {
  try { if (browser) await browser.close(); } catch (_) {}
  browser = null; page = null; lmsBase = null;
}

async function closeBrowser() {
  await destroyBrowser();
  logger.info('Scraper browser closed.');
  await sleep(1500);
}

async function isPageAlive(p) {
  try { await p.evaluate(() => true); return true; } catch (_) { return false; }
}

// Parse deadline as PKT (UTC+5) regardless of server timezone.
// "11 March 2026" → 23:59 PKT = 18:59 UTC
function parseDeadline(raw) {
  if (!raw) return null;
  try {
    const m = raw.replace(/\s*-\s*/g, ' ').match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (!m) return null;
    const utcEndOfDay = Date.UTC(
      parseInt(m[3]),
      new Date(`${m[2]} 1, 2000`).getMonth(),
      parseInt(m[1]),
      23, 59, 0
    );
    const deadlineMs = utcEndOfDay - PKT_OFFSET_MS; // convert PKT 23:59 → UTC
    return isNaN(deadlineMs) ? null : deadlineMs;
  } catch (_) { return null; }
}

async function login() {
  await destroyBrowser();
  const enrollment = process.env.CMS_ENROLLMENT;
  const password   = process.env.CMS_PASSWORD;
  const institute  = process.env.CMS_INSTITUTE_ID || '2';
  if (!enrollment || !password) throw new Error('CMS_ENROLLMENT and CMS_PASSWORD required in .env');

  logger.info('Launching scraper browser...');
  browser = await puppeteer.launch(getLaunchOptions());
  browser.on('disconnected', () => { browser = null; page = null; lmsBase = null; });

  page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', req => ['image','font','media'].includes(req.resourceType()) ? req.abort() : req.continue());

  logger.info('Logging into CMS...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let formReady = false;
  for (let i = 0; i < 3; i++) {
    try { await page.waitForSelector('#BodyPH_tbEnrollment', { timeout: 10000 }); formReady = true; break; }
    catch (_) { logger.warn(`Login form not ready (attempt ${i+1}/3)...`); await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); }
  }
  if (!formReady) throw new Error('Login form never appeared after 3 attempts.');

  await page.click('#BodyPH_tbEnrollment', { clickCount: 3 });
  await page.type('#BodyPH_tbEnrollment', enrollment, { delay: 30 });
  await page.click('#BodyPH_tbPassword', { clickCount: 3 });
  await page.type('#BodyPH_tbPassword', password, { delay: 30 });
  await page.select('#BodyPH_ddlInstituteID', institute);
  await sleep(300);

  const btn = await page.$('#BodyPH_btnLogin') || await page.$('input[type="submit"]');
  if (!btn) throw new Error('Login button not found.');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }), btn.click()]);

  const body = await page.$eval('body', el => el.innerText.toLowerCase()).catch(() => '');
  if (page.url().toLowerCase().includes('login') && (body.includes('invalid') || body.includes('incorrect'))) {
    alerts.cmsLoginFailed('Invalid credentials — check CMS_ENROLLMENT and CMS_PASSWORD.');
    throw new Error('CMS login failed — check credentials.');
  }

  logger.info('Logged in. Navigating to LMS...');
  await page.goto(GOTO_LMS, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  lmsBase = page.url().replace(/\/[^/]*(\?.*)?$/, '/');
  logger.info(`LMS base: ${lmsBase}`);
}

async function scrapeAssignments() {
  if (isRefreshing) { logger.warn('Session refresh in progress — skipping scrape.'); return []; }
  if (page && !(await isPageAlive(page))) { logger.warn('Stale page — will re-login.'); page = null; lmsBase = null; }
  if (!page) await login();

  const assignments = [];
  try {
    await page.goto(`${lmsBase}Assignments.php`, { waitUntil: 'networkidle2', timeout: 30000 });
    lmsBase = page.url().replace(/\/[^/]*(\?.*)?$/, '/');
    await page.waitForSelector('#courseId', { timeout: 15000 });

    const courses = await page.$$eval('#courseId option',
      opts => opts.filter(o => o.value.trim()).map(o => ({ value: o.value.trim(), name: o.textContent.trim() }))
    );
    logger.info(`Found ${courses.length} course(s).`);

    for (const course of courses) {
      logger.info(`Checking: ${course.name}`);
      await page.goto(`${lmsBase}Assignments.php`, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector('#courseId', { timeout: 10000 });
      await page.select('#courseId', course.value);
      await page.waitForFunction(
        () => document.querySelectorAll('.box-body.table-responsive .table-hover tbody tr').length > 0,
        { timeout: 6000 }
      ).catch(() => sleep(2000));

      const rows = await page.$$eval('.box-body.table-responsive .table-hover tbody tr', trs =>
        trs.map(tr => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 8) return null;
          const title = cells[1]?.innerText.trim() || '';
          const cell  = cells[7];
          const ext   = cell.querySelector('small.label-warning');
          const act   = cell.querySelector('small.label-info');
          return { title, deadlineRaw: (ext || act || cell).innerText.trim(), isExtended: !!ext };
        }).filter(Boolean)
      ).catch(() => []);

      for (const { title, deadlineRaw, isExtended } of rows) {
        if (!title || !deadlineRaw) continue;
        const deadlineMs = parseDeadline(deadlineRaw);
        if (deadlineMs) logger.info(`  "${title}" → ${new Date(deadlineMs).toISOString()} (PKT 23:59)`);
        assignments.push({ courseName: course.name, title, deadline: deadlineRaw, deadlineMs, isExtended });
      }
      logger.info(`  → ${rows.length} row(s)`);
    }
  } catch (err) {
    logger.error(`Scrape failed: ${err.message}`);
    alerts.scrapeFailed(err.message);
    page = null; lmsBase = null;
    throw err;
  }

  logger.info(`Total: ${assignments.length} assignment(s)`);
  return assignments;
}

async function refreshSession() {
  if (isRefreshing) { logger.warn('Refresh already in progress.'); return; }
  isRefreshing = true;
  logger.info('Refreshing CMS session...');
  try {
    await destroyBrowser();
    await sleep(500);
    await login();
    logger.info('Session refreshed.');
  } catch (err) {
    logger.error(`Session refresh failed: ${err.message}`);
    page = null; lmsBase = null;
  } finally {
    isRefreshing = false;
  }
}

module.exports = { scrapeAssignments, refreshSession, closeBrowser };