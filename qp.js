/*
  Quantum Pay automation
  Phase 1/2: Login + navigate to Sales page
  Phase 3: Iterate rows, fill form, (review: pause) or (no-review: submit+confirm), capture status, write back.
*/

/* eslint-disable no-console */

const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config();

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPuppeteer() {
  try {
    // Support ESM-only Puppeteer in CommonJS context
    // eslint-disable-next-line no-new-func
    const m = await (new Function('return import("puppeteer")'))();
    return m.default || m;
  } catch (err) {
    console.error('[%s] Failed to load puppeteer. Install it first: npm i puppeteer', now());
    throw err;
  }
}

// CLI flags
const hasFlag = (flag) => process.argv.includes(flag);
const REVIEW_MODE = hasFlag('--review') && !hasFlag('--no-review') ? true : (hasFlag('--no-review') ? false : true);

// Post-login hints (used to detect dashboard vs OTP/login screens)
const POST_LOGIN_HINTS = [
  // From captured dashboard DOM:
  '.sidebar-layout',
  '#app.app-wrapper',
  '.main-sidebar',
  '.app-header',
  '.q-breadcrumb',
  '.quick-sale-button',
  'span.q-button-title'
];

// Google OAuth/Gmail
let gmailClient = null;
async function ensureGmailAuth() {
  const { google } = require('googleapis');
  const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET in .env');
  }
  const redirectUri = 'http://localhost:3000/oauth2callback';
  const oAuth2Client = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, redirectUri);
  const tokenPath = path.join(process.cwd(), '.qp_gmail_token.json');
  // Load token if present
  if (fs.existsSync(tokenPath)) {
    try {
      const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      oAuth2Client.setCredentials(tok);
      gmailClient = google.gmail({ version: 'v1', auth: oAuth2Client });
      console.log('[%s] Loaded existing Gmail token.', now());
      return;
    } catch (_) {
      // fallthrough to new auth
    }
  }
  // Start local server to capture code
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/oauth2callback')) {
      const urlObj = new URL(req.url, redirectUri);
      const code = urlObj.searchParams.get('code');
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Authorization complete. You can close this tab and return to the app.');
        gmailClient = google.gmail({ version: 'v1', auth: oAuth2Client });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Auth failed: ${e.message}`);
      } finally {
        server.close();
      }
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(3000, '0.0.0.0', resolve));
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'];
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });
  console.log('[%s] Open this URL to authorize Gmail:\n%s', now(), authUrl);
  console.log('[%s] Waiting for OAuth completion...', now());
  // Wait until gmailClient is set by callback
  const deadline = Date.now() + 5 * 60 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (!gmailClient) {
    if (Date.now() > deadline) throw new Error('OAuth timed out.');
    await sleep(500);
  }
}

async function fetchOtpFromGmail(expectUsername) {
  if (!gmailClient) return '';
  const { google } = require('googleapis');
  try {
    // Wait 60s before checking as requested
    console.log('[%s] Waiting 60s before checking Gmail for OTP...', now());
    await sleep(60000);
    // Search last 5 messages from quantum
    const q = 'from:donotreply@quantumepay.com newer_than:1d';
    const list = await gmailClient.users.messages.list({
      userId: 'me',
      q,
      maxResults: 5,
    });
    const messages = list.data.messages || [];
    for (const m of messages) {
      const full = await gmailClient.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'full',
      });
      // Extract plain text from payload
      const payload = full.data.payload || {};
      let body = '';
      const extract = (part) => {
        if (!part) return;
        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
          const buff = Buffer.from(part.body.data, 'base64');
          body += buff.toString('utf8') + '\n';
        }
        if (part.parts) part.parts.forEach(extract);
      };
      extract(payload);
      if (!body) {
        // fallback to snippet
        body = full.data.snippet || '';
      }
      const hiMatch = body.match(/Hi\s+([A-Za-z0-9_-]+),/i);
      if (hiMatch && expectUsername && hiMatch[1].toLowerCase() !== String(expectUsername).toLowerCase()) {
        continue; // not our account
      }
      const codeMatch = body.match(/Authentication code is\s+(\d{4,8})/i) || body.match(/\b(\d{6})\b/);
      if (codeMatch) {
        const code = codeMatch[1];
        console.log('[%s] Found OTP code: %s', now(), code);
        return code;
      }
    }
  } catch (e) {
    console.warn('[%s] Gmail fetch error: %s', now(), e && e.message ? e.message : String(e));
  }
  return '';
}

function readFirstEligibleRowFromExcel(filePath) {
  // eslint-disable-next-line global-require
  const xlsx = require('xlsx');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
  const wb = xlsx.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // Try by header name first
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const headers = Object.keys(rows[0] || {}).map((h) => ({ raw: h, norm: normalize(h) }));
  const statusHeader =
    headers.find((h) => h.norm === 'associte charge status') // exact as provided (typo preserved)
    || headers.find((h) => h.norm.includes('associate') && h.norm.includes('status'))
    || null;
  const reservationHeader =
    headers.find((h) => h.norm === 'reservationid')
    || headers.find((h) => h.norm === 'reservation id')
    || headers.find((h) => h.norm.includes('reservation') && h.norm.includes('id'))
    || null;

  const valueByHeadersForRow = (rowObj, names) => {
    for (const n of names) {
      if (Object.prototype.hasOwnProperty.call(rowObj, n)) {
        const v = (rowObj[n] ?? '').toString().trim();
        if (v) return v;
      }
    }
    const normalizedRow = Object.keys(rowObj).reduce((acc, k) => {
      acc[normalize(k)] = (rowObj[k] ?? '').toString().trim(); return acc;
    }, {});
    for (const n of names) {
      const v = normalizedRow[normalize(n)];
      if (v) return v;
    }
    return '';
  };

  let rowIndex = -1;
  if (statusHeader) {
    for (let i = 0; i < rows.length; i += 1) {
      const statusVal = (rows[i][statusHeader.raw] ?? '').toString().trim();
      if (statusVal) continue;
      const reservationVal = reservationHeader
        ? (rows[i][reservationHeader.raw] ?? '').toString().trim()
        : valueByHeadersForRow(rows[i], ['ReservationID', 'Reservation ID']);
      if (!reservationVal) continue;
      const username = valueByHeadersForRow(rows[i], ['Quantam Pay Log In', 'Quantum Pay Log In', 'QP Login', 'Username']);
      const password = valueByHeadersForRow(rows[i], ['QP Password', 'Quantum Pay Password', 'Password']);
      if (!username || !password) continue;
      rowIndex = i;
      break;
    }
  }

  // Fallback: check column H directly if header approach failed
  if (rowIndex < 0) {
    const range = xlsx.utils.decode_range(ws['!ref']);
    // Assume first row is header, data starts at row 2 (r index + 1)
    for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
      const addr = xlsx.utils.encode_cell({ r, c: 7 }); // H -> index 7
      const cell = ws[addr];
      const statusVal = cell ? String(cell.v ?? cell.w ?? '').trim() : '';
      if (statusVal) continue;
      const reservationAddr = xlsx.utils.encode_cell({ r, c: 1 }); // B -> index 1
      const reservationCell = ws[reservationAddr];
      const reservationVal = reservationCell ? String(reservationCell.v ?? reservationCell.w ?? '').trim() : '';
      if (!reservationVal) continue;

      const candidateIndex = r - (range.s.r + 1);
      const rowObj = rows[candidateIndex] || {};
      const username = valueByHeadersForRow(rowObj, ['Quantam Pay Log In', 'Quantum Pay Log In', 'QP Login', 'Username']);
      const password = valueByHeadersForRow(rowObj, ['QP Password', 'Quantum Pay Password', 'Password']);
      if (!username || !password) continue;

      rowIndex = candidateIndex;
      break;
    }
  }

  if (rowIndex < 0) {
    throw new Error('No eligible row found with empty "Associte Charge Status" (Column H) and filled ReservationID (Column B).');
  }

  const row = rows[rowIndex];
  const valueByHeaders = (names) => {
    for (const n of names) {
      if (Object.prototype.hasOwnProperty.call(row, n)) {
        const v = (row[n] ?? '').toString().trim();
        if (v) return v;
      }
    }
    // try normalized
    const normalizedRow = Object.keys(row).reduce((acc, k) => {
      acc[normalize(k)] = (row[k] ?? '').toString().trim(); return acc;
    }, {});
    for (const n of names) {
      const v = normalizedRow[normalize(n)];
      if (v) return v;
    }
    return '';
  };

  const username = valueByHeaders(['Quantam Pay Log In', 'Quantum Pay Log In', 'QP Login', 'Username']);
  const password = valueByHeaders(['QP Password', 'Quantum Pay Password', 'Password']);
  if (!username || !password) {
    throw new Error('Missing credentials in sheet: need "Quantam Pay Log In" and "QP Password".');
  }
  return { rowIndex, username, password };
}

function readAllRowsFromExcel(filePath) {
  // eslint-disable-next-line global-require
  const xlsx = require('xlsx');
  if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
  const wb = xlsx.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  return { wb, ws, sheetName, rows: xlsx.utils.sheet_to_json(ws, { defval: '' }) };
}

function writeAssociteChargeStatus({ wb, ws, sheetName }, rowIndexZeroBased, statusValue) {
  // eslint-disable-next-line global-require
  const xlsx = require('xlsx');
  const range = xlsx.utils.decode_range(ws['!ref']);
  const headerRow = range.s.r;
  // Find "Associte Charge Status" column (typo expected) by normalized header
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let statusCol = null;
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = xlsx.utils.encode_cell({ r: headerRow, c });
    const cell = ws[addr];
    const txt = cell ? String(cell.v ?? cell.w ?? '').trim() : '';
    if (norm(txt) === 'associte charge status') { statusCol = c; break; }
  }
  if (statusCol === null) {
    statusCol = range.e.c + 1;
    const headerAddr = xlsx.utils.encode_cell({ r: headerRow, c: statusCol });
    ws[headerAddr] = { t: 's', v: 'Associte Charge Status' };
    range.e.c = statusCol;
    ws['!ref'] = xlsx.utils.encode_range(range);
  }
  const targetRow = headerRow + 1 + rowIndexZeroBased;
  const targetAddr = xlsx.utils.encode_cell({ r: targetRow, c: statusCol });
  ws[targetAddr] = { t: 's', v: statusValue };
  xlsx.writeFile(wb, path.join(process.cwd(), 'qp_input_file.xlsx'));
}

function getCellValueByHeaders(row, candidates) {
  const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, name)) {
      const v = (row[name] ?? '').toString().trim();
      if (v) return v;
    }
  }
  const normalizedRow = Object.keys(row).reduce((acc, k) => { acc[normalize(k)] = (row[k] ?? '').toString().trim(); return acc; }, {});
  for (const name of candidates) {
    const v = normalizedRow[normalize(name)];
    if (v) return v;
  }
  return '';
}

function toExpiryMmYy(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  // Digits only 4 => MMYY
  if (/^\d{4}$/.test(s)) {
    const mm = s.slice(0, 2);
    const yy = s.slice(2, 4);
    return `${mm}${yy}`;
  }
  // If looks like Excel serial (>=5 digits numeric), convert
  if (/^\d{5,}$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n) && n > 0) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const ms = n * 24 * 60 * 60 * 1000;
      const dt = new Date(epoch.getTime() + ms);
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const yy = String(dt.getUTCFullYear()).slice(2);
      return `${mm}${yy}`;
    }
  }
  // If in MM/YY or MM-YY
  const mmyy = s.match(/^(\d{1,2})\s*[\/\-]\s*(\d{2,4})$/);
  if (mmyy) {
    const mm = mmyy[1].padStart(2, '0');
    let yy = mmyy[2];
    if (yy.length === 4) yy = yy.slice(2);
    return `${mm}${yy}`;
  }
  // If general date parseable
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(2);
    return `${mm}${yy}`;
  }
  // Fallback: digits only, first 4
  return s.replace(/\D+/g, '').slice(0, 4);
}

async function waitForAnySelector(page, selectors, timeoutMs) {
  return page.waitForFunction(
    (sels) => sels.some((sel) => document.querySelector(sel)),
    { timeout: timeoutMs },
    selectors
  );
}

async function findFrameWithAllSelectors(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const frames = page.frames();
      for (const frame of frames) {
        const ok = await frame
          .evaluate(
            (sels) => sels.every((sel) => !!document.querySelector(sel)),
            selectors
          )
          .catch(() => false);
        if (ok) return frame;
      }
    } catch (_) {
      // ignore transient evaluation/navigation errors
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for frame containing: ${selectors.join(
      ', '
    )}`
  );
}

async function findFrameWithAnySelector(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const frames = page.frames();
      for (const frame of frames) {
        const found = await frame
          .evaluate((sels) => {
            for (const sel of sels) {
              if (document.querySelector(sel)) return sel;
            }
            return '';
          }, selectors)
          .catch(() => '');
        if (found) return { frame, selector: found };
      }
    } catch (_) {
      // ignore transient evaluation/navigation errors
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for any of: ${selectors.join(', ')}`
  );
}

async function waitForElementWithText(page, selector, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const target = (text || '').toLowerCase().trim();
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate(
        ({ selector: sel, textLower }) => {
          const els = Array.from(document.querySelectorAll(sel));
          for (const el of els) {
            const t = (el.textContent || '').toLowerCase().trim();
            if (t.includes(textLower)) {
              return true;
            }
          }
          return false;
        },
        { selector, textLower: target }
      );
      if (found) return true;
    } catch (_) {
      // ignore transient errors during client-side route changes
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${selector} containing "${text}"`);
}

async function hardRefresh(page) {
  const url = page.url();
  // Try direct navigation to current URL
  for (let i = 0; i < 2; i += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return true;
    } catch (_) {}
  }
  // Fallback to reload API
  for (let i = 0; i < 2; i += 1) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      return true;
    } catch (_) {}
  }
  return false;
}

async function waitForUrlToStabilize(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stableForMs = 0;
  while (Date.now() < deadline) {
    let u = '';
    try { u = page.url() || ''; } catch (_) { u = ''; }
    if (u && u === last) {
      stableForMs += 300;
      if (stableForMs >= 1200) return u;
    } else {
      last = u;
      stableForMs = 0;
    }
    await sleep(300);
  }
  return last;
}

async function safeGotoWithRedirects(page, url, opts = {}) {
  const {
    timeoutMs = 120000,
    maxAttempts = 4,
    settleTimeoutMs = 12000,
  } = opts;

  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt += 1) {
    const remaining = Math.max(5000, deadline - Date.now());
    try {
      console.log('[%s] goto attempt %d/%d -> %s', now(), attempt, maxAttempts, url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 100000 });
      // Important: allow for 2-3 redirects that happen after DOMContentLoaded
      await waitForUrlToStabilize(page, Math.min(settleTimeoutMs, deadline - Date.now()));
      return true;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      // Common transient error during redirect chains / navigation races
      const transient = /Execution context was destroyed|Cannot find context with specified id|net::ERR_ABORTED|Navigation failed because/i.test(msg);
      console.warn('[%s] goto failed (attempt %d): %s', now(), attempt, msg);
      if (!transient) {
        // still retry a couple times, but with a short delay
      }
      await sleep(1200);
    }
  }

  throw lastErr || new Error(`Failed to navigate to ${url}`);
}

async function setInputValue(page, selector, value, opts = {}) {
  const { delay = 20, verify = true, method = 'type' } = opts;
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  // Clear robustly
  try {
    await page.click(selector, { clickCount: 3 });
    for (let i = 0; i < 4; i += 1) { // extra clears
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
    }
  } catch (_) {}
  // Type
  try {
    if (value) {
      if (method === 'paste') {
        // Simulate paste to insert full text at once (useful for masked inputs)
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.focus();
          const evt = new InputEvent('input', { inputType: 'insertFromPaste', data: val, bubbles: true });
          el.value = val;
          el.dispatchEvent(evt);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (typeof el.blur === 'function') el.blur();
        }, selector, value);
      } else {
        await page.type(selector, value, { delay });
      }
    }
  } catch (_) {}
  if (!verify) return;
  try {
    const typed = await page.$eval(selector, (el) => (el.value || '').toString());
    if (!typed || typed.trim() === '') {
      // Fallback: set directly and dispatch events
      await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur?.();
        }
      }, selector, value);
    }
  } catch (_) {}
}

async function ensureOnSalePage(page, opts = {}) {
  const {
    buttonTimeoutMs = 120000,
    navTimeoutMs = 90000,
    saleTimeoutMs = 120000,
  } = opts;
  // If already on sale, return
  const isSale = await page.evaluate(() => {
    const t = document.querySelector('div.q-card-heading .q-title');
    return t && /credit card sale/i.test((t.textContent || '').trim());
  }).catch(() => false);
  if (isSale) return;
  // Else open Quick Sale
  await waitForElementWithText(page, 'span.q-button-title', 'Quick Sale', buttonTimeoutMs);
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span.q-button-title'));
    const span = spans.find(s => (s.textContent || '').trim().toLowerCase().includes('quick sale'));
    if (span) { const btn = span.closest('button'); if (btn) btn.click(); }
  });
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => null),
    (async () => { await sleep(1500); })()
  ]);
  await Promise.race([
    waitForElementWithText(page, 'div.q-card-heading .q-title', 'Credit Card Sale', saleTimeoutMs),
    waitForElementWithText(page, 'button .q-button-title', 'Select a Customer', saleTimeoutMs)
  ]);
}

async function fillSaleForm(page, row, rowIndex) {
  // Values from row
  const cardLast12 = getCellValueByHeaders(row, ['Card last 12', 'Card Last 12', 'Last 12', 'Card last twelve']);
  const expiryRaw = getCellValueByHeaders(row, ['Card Expire MM/YY', 'Expiry', 'Expiration']);
  const cvv = getCellValueByHeaders(row, ['Card CVV', 'CVV']);
  const amount = getCellValueByHeaders(row, ['Amount to charge', 'Amount', 'Charge Amount']);
  const firstName = getCellValueByHeaders(row, ['Name', 'First Name']);
  const address1 = getCellValueByHeaders(row, ['Address', 'Address 1']);
  const city = getCellValueByHeaders(row, ['City']);
  const zip = getCellValueByHeaders(row, ['Zip Code', 'Postal Code', 'Zip']);
  const orderId = getCellValueByHeaders(row, ['ReservationID', 'Reservation ID', 'Order ID']);

  const expiry = toExpiryMmYy(expiryRaw);
  const expiryDigits = (expiry || '').replace(/\D+/g, '').slice(0, 4); // enter as MMYY (no slash)
  console.log('[%s] Row %d values -> cardLast12: "%s", expiryRaw: "%s", expiry: "%s", cvv: "%s", amount: "%s", firstName: "%s", address1: "%s", city: "%s", zip: "%s", orderId: "%s"',
    now(), (rowIndex != null ? rowIndex + 1 : -1),
    (cardLast12 || ''), (expiryRaw || ''), (expiry || ''), (cvv || ''), (amount || ''),
    (firstName || ''), (address1 || ''), (city || ''), (zip || ''), (orderId || ''));

  // Card Number
  const cardSelector = 'input[name="CardNumber"].input';
  const cardDigits = String(cardLast12 || '').replace(/\D+/g, ''); // use exactly as provided, no spaces
  // Type one-by-one to let mask format it; no spaces in input value
  await setInputValue(page, cardSelector, '', { delay: 0, verify: false });
  if (cardDigits) {
    for (const ch of cardDigits) {
      await page.type(cardSelector, ch, { delay: 60 });
    }
    // brief settle
    await sleep(150);
  }
  try {
    const cardNow = await page.$eval(cardSelector, el => (el.value || '').toString());
    const cardNowDigits = cardNow.replace(/\D+/g, '');
    console.log('[%s] Row %d field check -> CardNumber now: "%s" (digits=%s) expected=%s', now(), (rowIndex != null ? rowIndex + 1 : -1), cardNow, cardNowDigits, cardDigits);
    if (cardDigits && cardNowDigits !== cardDigits) {
      // Type remaining digits only
      const remaining = cardDigits.slice(cardNowDigits.length);
      for (const ch of remaining) {
        await page.type(cardSelector, ch, { delay: 60 });
      }
      await sleep(150);
    }
  } catch (_) {}

  // Expiration
  const expSelector = 'input[name="account_expiry_date"].input';
  await setInputValue(page, expSelector, '', { delay: 0, verify: false });
  if (expiryDigits) {
    for (const ch of expiryDigits) {
      await page.type(expSelector, ch, { delay: 50 });
    }
    await sleep(120);
  }
  try {
    const expNow = await page.$eval(expSelector, el => (el.value || '').toString());
    const expNowDigits = expNow.replace(/\D+/g, '');
    console.log('[%s] Row %d field check -> Expiry now: "%s" (digits=%s) expected=%s', now(), (rowIndex != null ? rowIndex + 1 : -1), expNow, expNowDigits, expiryDigits);
    if (expiryDigits && expNowDigits !== expiryDigits) {
      // Retype if mismatch
      await setInputValue(page, expSelector, '', { delay: 0, verify: false });
      for (const ch of expiryDigits) {
        await page.type(expSelector, ch, { delay: 20 });
      }
    }
  } catch (_) {}

  // CVV
  await setInputValue(page, 'input[name="account_card_security_code"].input', String(cvv || '').replace(/\D+/g, '').slice(0, 4), { delay: 15, verify: false });

  // Amount (currency input next to button with same id; use the currency input)
  const amountSelector = '.amount-info-row input.input.currency';
  await setInputValue(page, amountSelector, String(amount || '').replace(/[^\d.]+/g, ''), { delay: 10, verify: false });

  // Billing First Name
  await setInputValue(page, 'input[name="account_first_name"].input', String(firstName || '').trim(), { delay: 10, verify: false });

  // Address 1
  await setInputValue(page, 'input[name="account_billing_address_address_1"].input', address1 || '', { delay: 10, verify: false });

  // City
  await setInputValue(page, 'input[name="account_billing_address_city"].input', city || '', { delay: 10, verify: false });

  // State multiselect: type 'Washington' and choose first option
  await page.evaluate(() => {
    // tag the multiselect inside the Field whose label is exactly 'State'
    const labels = Array.from(document.querySelectorAll('.field .no-label label'));
    const lab = labels.find(l => (l.textContent || '').trim().toLowerCase() === 'state');
    if (lab) {
      const field = lab.closest('.field');
      const ms = field && field.querySelector('.multiselect');
      if (ms) {
        ms.setAttribute('data-qa-state', '1');
        ms.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        ms.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        ms.click?.();
      }
    }
  });
  await page.waitForSelector('.multiselect[data-qa-state=\"1\"].is-open .multiselect-search', { timeout: 100 }).catch(() => {});
  // Type search term
  await page.type('.multiselect[data-qa-state=\"1\"] .multiselect-search', 'Washington', { delay: 60 }).catch(() => {});
  // Wait for the option to render
  await page.waitForFunction(() => {
    const dd = document.querySelector('.multiselect[data-qa-state=\"1\"] .multiselect-dropdown');
    if (!dd || dd.classList.contains('is-hidden')) return false;
    const spans = Array.from(dd.querySelectorAll('.multiselect-option span'));
    return spans.some(s => (s.textContent || '').trim().toLowerCase() === 'washington');
  }, { timeout: 15000 }).catch(() => {});
  // Click the exact "Washington" option
  await page.evaluate(() => {
    const dd = document.querySelector('.multiselect[data-qa-state=\"1\"] .multiselect-dropdown');
    if (dd) {
      const spans = Array.from(dd.querySelectorAll('.multiselect-option span'));
      const match = spans.find(s => (s.textContent || '').trim().toLowerCase() === 'washington');
      const li = match ? match.closest('.multiselect-option') : null;
      if (li) {
        li.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        li.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        li.click?.();
      }
    }
    const ms = document.querySelector('.multiselect[data-qa-state=\"1\"]');
    if (ms) ms.removeAttribute('data-qa-state');
  }).catch(() => {});
  // Verify selection shows in single label
  await page.waitForFunction(() => {
    const ms = document.querySelector('.field .multiselect');
    if (!ms) return false;
    const lbl = ms.querySelector('.multiselect-single-label-text');
    return !!(lbl && /washington/i.test((lbl.textContent || '').trim()));
  }, { timeout: 1000 }).catch(() => {});

  // Zip
  await setInputValue(page, 'input[name="account_billing_address_postal_code"].input', String(zip || '').replace(/\D+/g, ''), { delay: 25, verify: false });

  // Expand Order Information if collapsed
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.q-panelbar-item'));
    const orderItem = items.find(it => {
      const title = it.querySelector('.q-panelbar-title .left-side');
      return title && /order information/i.test((title.textContent || '').trim());
    });
    if (orderItem) {
      const body = orderItem.querySelector('.q-panelbar-body');
      if (body && !body.classList.contains('is-expanded')) {
        const btn = orderItem.querySelector('.q-panelbar-title');
        if (btn) (btn).click();
      }
    }
  });
  // Order ID / PO Number
  await setInputValue(page, 'input[name="order_order_id"].input', orderId || '', { delay: 10, verify: false });
}

async function clickProcessPaymentAndConfirm(page) {
  // Primary process payment button on page
  await waitForElementWithText(page, 'button .q-button-title', 'Process Payment', 60000);
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('button .q-button-title'));
    const span = spans.find(s => (s.textContent || '').trim().toLowerCase().includes('process payment'));
    if (span) { const btn = span.closest('button'); if (btn) (btn).click(); }
  });
  // Allow confirm modal to render/settle (important)
  await sleep(2500);

  // Confirm modal "Process Payment" button (classes/ids may be dynamic; click by visible text)
  await waitForConfirmModalAndClickButtonByText(page, 'Process Payment', 60000);
  // Allow transaction complete modal to render/settle (important)
  await sleep(2500);
}

async function waitForConfirmModalAndClickButtonByText(page, buttonText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const clicked = await page.evaluate((txt) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = norm(txt);
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const clickInRoot = (root) => {
          const candidates = Array.from(root.querySelectorAll('button'));
          for (const btn of candidates) {
            if (btn.getAttribute('aria-hidden') === 'true') continue;
            if (btn.disabled) continue;
            const label = norm(btn.innerText || btn.textContent || '');
            if (!label) continue;
            if (label === target || label.includes(target)) {
              if (!isVisible(btn)) continue;
              try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
              try { btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); } catch (_) {}
              try { btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) {}
              try { btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) {}
              try { btn.click(); } catch (_) {}
              return true;
            }
          }
          return false;
        };
        // Prefer confirm modal container if present
        const roots = [
          ...Array.from(document.querySelectorAll('.modal-container')),
          ...Array.from(document.querySelectorAll('div[role="dialog"]')),
          ...Array.from(document.querySelectorAll('.modal')),
          document.body
        ];
        for (const root of roots) {
          // Only interact with visible roots (avoid hidden/offscreen templates)
          if (!isVisible(root)) continue;
          if (clickInRoot(root)) return true;
        }
        return false;
      }, buttonText);
      if (clicked) return true;
    } catch (_) {
      // ignore transient navigation/context errors
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting to click confirm modal button: ${buttonText}`);
}

async function getTransactionHeaderH2Text(page) {
  return page.evaluate(() => {
    const h2 = document.querySelector('.title-wrap.transaction-header-container h2');
    return (h2 && (h2.textContent || '').trim()) || '';
  }).catch(() => '');
}

async function getFirstDialogH2Text(page) {
  return page.evaluate(() => {
    const scopes = Array.from(document.querySelectorAll('div[role="dialog"], .modal, body'));
    for (const root of scopes) {
      const h2s = Array.from(root.querySelectorAll('h2'));
      for (const h of h2s) {
        const t = (h.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  }).catch(() => '');
}

async function findFrameWithAnySelectorNow(page, selectors) {
  try {
    const frames = page.frames();
    for (const frame of frames) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await frame
        .evaluate((sels) => sels.some((sel) => !!document.querySelector(sel)), selectors)
        .catch(() => false);
      if (ok) return frame;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

async function setInputValueInFrame(page, frame, selector, value, opts = {}) {
  const { delay = 20, verify = true } = opts;
  await frame.waitForSelector(selector, { visible: true, timeout: 30000 });
  try {
    await frame.click(selector, { clickCount: 3 });
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Backspace').catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Delete').catch(() => {});
    }
  } catch (_) {}
  try {
    if (value) await frame.type(selector, value, { delay });
  } catch (_) {}
  if (!verify) return;
  try {
    const typed = await frame.$eval(selector, (el) => (el.value || '').toString());
    if (!typed || typed.trim() === '') {
      await frame.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur?.();
        }
      }, selector, value);
    }
  } catch (_) {}
}

async function solveOtpInFrameIfPresent(page, expectUsername) {
  const OTP_SELECTORS = [
    'input#OTP', 'input[name*="otp"]', 'input[id*="otp"]',
    'input[name*="twofactor"]', 'input[id*="twofactor"]',
    'input[name*="code"]', 'input[id*="code"]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]'
  ];
  const otpFrame = await findFrameWithAnySelectorNow(page, OTP_SELECTORS);
  if (!otpFrame) return false;

  console.log('[%s] OTP step detected (no-review). Attempting auto-solve via Gmail...', now());
  const code = await fetchOtpFromGmail(expectUsername);
  if (!code) return true; // OTP exists but we couldn't fetch; user can enter manually

  try {
    const multi = await otpFrame.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"]'));
      const oneChar = inputs.filter((el) => el.getAttribute('maxlength') === '1');
      return oneChar.length >= 4;
    }).catch(() => false);

    if (multi) {
      await otpFrame.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"]'))
          .filter((el) => el.getAttribute('maxlength') === '1');
        if (inputs[0]) inputs[0].focus();
      }).catch(() => {});
      for (const ch of String(code)) {
        // eslint-disable-next-line no-await-in-loop
        await page.keyboard.type(ch, { delay: 80 });
      }
    } else {
      const sel = 'input#OTP, input[name*="otp"], input[id*="otp"], input[name*="code"], input[id*="code"], input[autocomplete="one-time-code"], input[type="tel"]';
      await setInputValueInFrame(page, otpFrame, sel, String(code), { delay: 20, verify: true });
    }

    await otpFrame.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const b = btns.find((x) => /submit|verify|continue/i.test((x.textContent || x.value || '').trim()));
      if (b) (b).click();
    }).catch(() => {});
  } catch (_) {
    // ignore; user can still solve manually
  }

  return true;
}

async function waitForTransactionStatusModal(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Prefer the transaction modal header container (more specific/accurate)
      let text = await getTransactionHeaderH2Text(page);
      if (!text) text = await getFirstDialogH2Text(page);
      if (text) {
        // Let modal settle to avoid reading transient/incorrect text
        await sleep(2000);
        let text2 = await getTransactionHeaderH2Text(page);
        if (!text2) text2 = await getFirstDialogH2Text(page);
        return (text2 || text);
      }
    } catch (_) {}
    await sleep(500);
  }
  return '';
}

async function waitForTransactionStatusModalNoReview(page, expectUsername, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let otpAttempted = false;
  while (Date.now() < deadline) {
    let text = await getTransactionHeaderH2Text(page);
    if (!text) text = await getFirstDialogH2Text(page);
    if (text) {
      await sleep(2000);
      let text2 = await getTransactionHeaderH2Text(page);
      if (!text2) text2 = await getFirstDialogH2Text(page);
      return (text2 || text);
    }

    if (!otpAttempted) {
      const otpFrame = await findFrameWithAnySelectorNow(page, [
        'input#OTP', 'input[name*="otp"]', 'input[id*="otp"]',
        'input[name*="twofactor"]', 'input[id*="twofactor"]',
        'input[name*="code"]', 'input[id*="code"]',
        'input[autocomplete="one-time-code"]',
        'input[type="tel"]'
      ]);
      if (otpFrame) {
        otpAttempted = true;
        // best-effort auto solve (may still require manual OTP)
        await solveOtpInFrameIfPresent(page, expectUsername);
      }
    }

    await sleep(500);
  }
  return '';
}

async function closeTransactionCompleteModal(page) {
  // Prefer the explicit close button in the transaction completed modal
  try {
    await page.waitForFunction(() => {
      const btn = document.querySelector('button.v-modal-close[aria-label="close"]');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, { timeout: 60000 });
    // Let modal settle before interacting (important)
    await sleep(2000);
    await page.evaluate(() => {
      const btn = document.querySelector('button.v-modal-close[aria-label="close"]');
      if (!btn) return;
      try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      try { btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); } catch (_) {}
      try { btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (_) {}
      try { btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch (_) {}
      btn.click?.();
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function logoutIfNeededAndRelogin(page, currentCreds, nextCreds, descriptor, confirmCell, doLogin) {
  const credsChanged = currentCreds.username !== nextCreds.username || currentCreds.password !== nextCreds.password;
  const mustLogoutFlag = /please log out before moving to the next record/i.test(descriptor || '') && /confirm/i.test((confirmCell || ''));
  if (credsChanged || mustLogoutFlag) {
    console.log('[%s] Logging out to switch credentials...', now());
    // Click logout icon
    await page.evaluate(() => {
      const el = document.querySelector('div.logout');
      if (el) (el).click();
    }).catch(() => {});
    // Wait for login selectors
    await Promise.race([
      waitForAnySelector(page, ['#Username', '#Password', '#login'], 120000),
      (async () => { await sleep(1500); })()
    ]).catch(() => {});
    // Login with next credentials
    await doLogin(nextCreds.username, nextCreds.password, page);
    // Ensure back to sale page
    await ensureOnSalePage(page);
    currentCreds.username = nextCreds.username;
    currentCreds.password = nextCreds.password;
  }
}

function shouldRelaunch(currentCreds, nextCreds, descriptor, confirmCell) {
  const credsChanged = currentCreds.username !== nextCreds.username || currentCreds.password !== nextCreds.password;
  const mustLogoutFlag = /please log out before moving to the next record/i.test(descriptor || '') && /confirm/i.test((confirmCell || ''));
  return credsChanged || mustLogoutFlag;
}

async function performLoginFlow(page, username, password) {
  // Find login frame
  const loginFrame = await findFrameWithAllSelectors(page, ['#Username', '#Password'], 120000);
  await sleep(25000); //the secret of life - the secret sauce
  await loginFrame.click('#Username', { clickCount: 3 });
  await loginFrame.type('#Username', username, { delay: 20 });
  await loginFrame.click('#Password', { clickCount: 3 });
  await loginFrame.type('#Password', password, { delay: 20 });
  // Click Sign in
  try {
    await loginFrame.waitForSelector('#login', { timeout: 30000 });
    await Promise.race([
      loginFrame.click('#login'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
    ]);
  } catch (_) {
    await loginFrame.evaluate(() => {
      const btn = document.querySelector('#login');
      if (btn) (btn).click();
      const form = document.querySelector('form');
      if (form && typeof (form).submit === 'function') (form).submit();
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null);
  }
  // OTP handling
  const OTP_SELECTORS = [
    'input#OTP', 'input[name*="otp"]', 'input[id*="otp"]',
    'input[name*="twofactor"]', 'input[id*="twofactor"]',
    'input[name*="code"]', 'input[id*="code"]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]'
  ];
  let onOtpPage = false;
  let otpFrame = null;
  try {
    const res = await findFrameWithAnySelector(page, OTP_SELECTORS, 120000);
    otpFrame = res.frame;
    onOtpPage = true;
    console.log('[%s] OTP input detected. Please enter your code manually and submit.', now());
  } catch (_) {
    try {
      await waitForAnySelector(page, POST_LOGIN_HINTS, 20000);
      onOtpPage = false;
    } catch (e) {
      console.warn('[%s] Neither OTP nor post-login hints were detected in time.', now());
    }
  }
  if (onOtpPage) {
    // Try to fetch OTP from Gmail after 60s and auto-submit
    const code = await fetchOtpFromGmail(username);
    if (code) {
      try {
        // Type into either single input or multiple boxes
        const multi = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"]'));
          const oneChar = inputs.filter(el => el.getAttribute('maxlength') === '1');
          return oneChar.length >= 4;
        });
        if (multi) {
          // Focus the first one-digit box and type sequentially
          await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"]'))
              .filter(el => el.getAttribute('maxlength') === '1');
            if (inputs[0]) inputs[0].focus();
          });
          for (const ch of String(code)) {
            await page.keyboard.type(ch, { delay: 80 });
          }
        } else {
          // Find a generic OTP/code input
          const sel = 'input#OTP, input[name*="otp"], input[id*="otp"], input[name*="code"], input[id*="code"], input[autocomplete="one-time-code"], input[type="tel"]';
          await setInputValue(page, sel, String(code), { delay: 20, verify: true });
        }
        // Click submit/verify/continue
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          const b = btns.find(x => /submit|verify|continue/i.test((x.textContent || x.value || '').trim()));
          if (b) (b).click();
        }).catch(() => {});
      } catch (_) {
        // ignore and fall back to manual submit wait
      }
    }
    console.log('[%s] Waiting for OTP submission...', now());
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 240000 }).catch(() => null),
      (async () => {
        const deadline = Date.now() + 240000;
        while (Date.now() < deadline) {
          try {
            const stillThere = await otpFrame
              .evaluate((sels) => sels.some((sel) => document.querySelector(sel)), OTP_SELECTORS)
              .catch(() => false);
            if (!stillThere) return;
          } catch (_) { return; }
          await sleep(750);
        }
      })()
    ]);
  }
  await waitForAnySelector(page, POST_LOGIN_HINTS, 60000).catch(() => {});
}

async function maybeLoginIfNeeded(page, creds) {
  try {
    const frame = await findFrameWithAllSelectors(page, ['#Username', '#Password'], 1500).catch(() => null);
    if (frame) {
      console.log('[%s] Login page detected mid-flow. Performing login again...', now());
      await performLoginFlow(page, creds.username, creds.password);
    } else {
      console.log('[%s] Login page not detected; continuing session.', now());
    }
  } catch (_) {
    // ignore
  }
}

async function isLoginPagePresent(page) {
  const frame = await findFrameWithAllSelectors(page, ['#Username', '#Password'], 1200).catch(() => null);
  return Boolean(frame);
}

async function isDashboardLikely(page) {
  return page.evaluate(() => {
    const hasWrapper = !!(document.querySelector('.sidebar-layout')
      || document.querySelector('#app.app-wrapper')
      || document.querySelector('.main-sidebar')
      || document.querySelector('.app-header'));
    const hasQuickSale = Array.from(document.querySelectorAll('span.q-button-title'))
      .some((el) => /quick sale/i.test((el.textContent || '').trim()));
    const hasDashboardCrumb = Array.from(document.querySelectorAll('.q-breadcrumb .label'))
      .some((el) => /dashboard/i.test((el.textContent || '').trim()));
    return Boolean(hasWrapper && (hasQuickSale || hasDashboardCrumb));
  }).catch(() => false);
}

async function waitForDashboardStable(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // If login is present, we're definitely not stable on dashboard yet.
    // eslint-disable-next-line no-await-in-loop
    if (await isLoginPagePresent(page)) return false;
    // eslint-disable-next-line no-await-in-loop
    const ok = await isDashboardLikely(page);
    if (ok) {
      // quick stability check (avoid false positives during transitions)
      // eslint-disable-next-line no-await-in-loop
      await sleep(1500);
      // eslint-disable-next-line no-await-in-loop
      if (await isLoginPagePresent(page)) return false;
      // eslint-disable-next-line no-await-in-loop
      const ok2 = await isDashboardLikely(page);
      if (ok2) return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  return false;
}

async function maybeLoginTwiceIfNeeded(page, creds, gapMs = 10000) {
  await maybeLoginIfNeeded(page, creds);
  await sleep(gapMs);
  await maybeLoginIfNeeded(page, creds);
}

function isTransientExecutionContextError(err) {
  const msg = err && (err.message || err.stack) ? String(err.message || err.stack) : String(err);
  return /Execution context was destroyed|Cannot find context with specified id|Protocol error|Target closed|net::ERR_ABORTED|Navigation failed because/i.test(msg);
}

async function runOnce(puppeteer) {
  // Read inputs
  const inputPath = path.join(process.cwd(), 'qp_input_file.xlsx');
  console.log('[%s] Reading %s ...', now(), inputPath);

  let firstCreds;
  try {
    firstCreds = readFirstEligibleRowFromExcel(inputPath);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/No eligible row found/i.test(msg)) {
      console.log('[%s] No eligible rows remaining. Exiting.', now());
      return { done: true, exitCode: 0 };
    }
    throw e;
  }

  const { wb, ws, sheetName, rows } = readAllRowsFromExcel(inputPath);
  const { username, password } = firstCreds;
  console.log('[%s] Using credentials for Quantum Pay login.', now());

  console.log('[%s] Launching Chromium (non-headless)...', now());
  let browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--start-maximized',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-blink-features=AutomationControlled',
      '--disable-extensions',
      '--disable-features=TranslateUI',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  try {
    let page = await browser.newPage();
    const url = 'https://gateway.quantumepay.com/';
    console.log('[%s] Navigating to %s ...', now(), url);
    await safeGotoWithRedirects(page, url, { timeoutMs: 120000, maxAttempts: 5, settleTimeoutMs: 15000 });

    // Use unified login flow (handles OTP via Gmail when available)
    console.log('[%s] Performing login flow...', now());
    await performLoginFlow(page, username, password);

    // Confirm dashboard readiness, then navigate to Sales page
    const dashOk = await waitForDashboardStable(page, 60000).catch(() => false);
    if (dashOk) {
      console.log('[%s] Dashboard appears stable.', now());
    } else {
      console.warn('[%s] Dashboard not confirmed stable yet; proceeding to Quick Sale detection.', now());
    }

    // Go to Sale page
    await ensureOnSalePage(page);
    console.log('[%s] Sale page detected.', now());

    // Phase 3: Iterate rows
    let currentCreds = { username, password };
    const processedReviewRows = new Set();
    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];
      if (REVIEW_MODE && processedReviewRows.has(idx)) {
        continue;
      }
      // Skip rows with existing status
      const statusCell = getCellValueByHeaders(row, ['Associte Charge Status', 'Associate Charge Status', 'Status']);
      if (String(statusCell || '').trim()) {
        continue;
      }
      // Skip rows where ReservationID (Column B) is empty (do not trigger relaunch/logout logic)
      const reservationId = getCellValueByHeaders(row, ['ReservationID', 'Reservation ID']);
      if (!String(reservationId || '').trim()) {
        console.log('[%s] Row %d skipped: empty ReservationID (Column B).', now(), idx + 1);
        continue;
      }
      // Determine next credentials for this row
      const rowUsername = getCellValueByHeaders(row, ['Quantam Pay Log In', 'Quantum Pay Log In', 'QP Login', 'Username']);
      const rowPassword = getCellValueByHeaders(row, ['QP Password', 'Quantum Pay Password', 'Password']);
      const descriptor = getCellValueByHeaders(row, ['Expedia Descriptor']);
      const confirmCell = statusCell;

      // If creds changed or descriptor indicates logout, re-launch a fresh browser/session
      const nextCreds = { username: rowUsername || currentCreds.username, password: rowPassword || currentCreds.password };
      if (shouldRelaunch(currentCreds, nextCreds, descriptor, confirmCell)) {
        console.log('[%s] Restarting browser to switch credentials...', now());
        try { await browser.close(); } catch (_) {}
        browser = await puppeteer.launch({
          headless: false,
          defaultViewport: null,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
          args: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--start-maximized',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--disable-features=TranslateUI',
            '--no-first-run',
            '--no-default-browser-check'
          ]
        });
        page = await browser.newPage();
        const url2 = 'https://gateway.quantumepay.com/';
        console.log('[%s] Navigating to %s ...', now(), url2);
        await safeGotoWithRedirects(page, url2, { timeoutMs: 120000, maxAttempts: 5, settleTimeoutMs: 15000 }).catch(() => {});
        await performLoginFlow(page, nextCreds.username, nextCreds.password);
        await ensureOnSalePage(page);
        currentCreds = { ...nextCreds };
      }

      // Make sure we're on sale page before filling
      // Double-check login page (refresh can sometimes kick us back unexpectedly)
      await maybeLoginTwiceIfNeeded(page, currentCreds, 10000);
      await ensureOnSalePage(page);

      // Fill sale form
      await fillSaleForm(page, row, idx);

      if (REVIEW_MODE) {
        console.log('[%s] Review mode: holding 15s then hard-refreshing for next row...', now());
        await sleep(15000);
        processedReviewRows.add(idx);
        // Hard refresh via navigation to same URL (avoids execution context issues)
        const t0 = Date.now();
        const refreshed = await hardRefresh(page);
        console.log('[%s] Hard refresh done (ok=%s) in %dms', now(), refreshed, Date.now() - t0);
        // Ensure Sale page is ready before next row
        console.log('[%s] Checking if login needed...', now());
        const l0 = Date.now();
        await maybeLoginIfNeeded(page, currentCreds);
        console.log('[%s] maybeLoginIfNeeded done in %dms', now(), Date.now() - l0);
        console.log('[%s] Ensuring Sale page...', now());
        const s0 = Date.now();
        await ensureOnSalePage(page, { buttonTimeoutMs: 5000, navTimeoutMs: 5000, saleTimeoutMs: 5000 }).catch(() => {});
        console.log('[%s] ensureOnSalePage done in %dms', now(), Date.now() - s0);
        // Explicitly wait for Card Number field so the next iteration can start filling immediately (short timeout)
        await page.waitForSelector('input[name="CardNumber"].input', { timeout: 5000 }).catch(() => {});
        continue;
      }

      // No-review: submit
      console.log('[%s] Submitting payment...', now());
      await clickProcessPaymentAndConfirm(page);
      const statusText = await waitForTransactionStatusModalNoReview(page, currentCreds.username, 180000);
      console.log('[%s] Transaction status: %s', now(), statusText || 'N/A');
      try {
        writeAssociteChargeStatus({ wb, ws, sheetName }, idx, statusText || '');
      } catch (e) {
        console.warn('[%s] Failed to write status for row %d: %s', now(), idx + 1, e && e.message ? e.message : String(e));
      }

      // Close transaction complete modal and confirm we're back on sale page
      const closed = await closeTransactionCompleteModal(page);
      if (!closed) {
        await page.keyboard.press('Escape').catch(() => {});
      }
      // Validate return to sale page (card input is a good signal)
      await Promise.race([
        page.waitForSelector('input[name="CardNumber"].input', { timeout: 60000 }).catch(() => {}),
        (async () => { await ensureOnSalePage(page); })()
      ]).catch(() => {});

      // Match review-mode pacing: hold 15s then hard-refresh and re-stabilize for next row
      console.log('[%s] No-review: holding 15s then hard-refreshing for next row...', now());
      await sleep(15000);
      const t0 = Date.now();
      const refreshed = await hardRefresh(page);
      console.log('[%s] Hard refresh done (ok=%s) in %dms', now(), refreshed, Date.now() - t0);

      console.log('[%s] Checking if login needed...', now());
      const l0 = Date.now();
      await maybeLoginIfNeeded(page, currentCreds);
      console.log('[%s] maybeLoginIfNeeded done in %dms', now(), Date.now() - l0);

      console.log('[%s] Ensuring Sale page...', now());
      const s0 = Date.now();
      await ensureOnSalePage(page, { buttonTimeoutMs: 5000, navTimeoutMs: 5000, saleTimeoutMs: 5000 }).catch(() => {});
      console.log('[%s] ensureOnSalePage done in %dms', now(), Date.now() - s0);

      // Explicitly wait for Card Number field so the next iteration can start filling immediately (short timeout)
      await page.waitForSelector('input[name="CardNumber"].input', { timeout: 5000 }).catch(() => {});
    }

    return { done: true, exitCode: 0 };
  } finally {
    console.log('[%s] Closing browser...', now());
    try { /* eslint-disable no-unused-expressions */ (await 0), browser && (await browser.close()); } catch (e) { /* ignore */ }
  }
}

async function main() {
  const puppeteer = await importPuppeteer();

  // Ensure Gmail OAuth before starting browser so OTP can be automated
  try {
    await ensureGmailAuth();
  } catch (e) {
    console.warn('[%s] Gmail OAuth skipped/failed: %s. OTP will require manual entry.', now(), e && e.message ? e.message : String(e));
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      console.log('[%s] Run attempt %d starting...', now(), attempt);
      const res = await runOnce(puppeteer);
      if (res && res.done) {
        process.exit(res.exitCode || 0);
      }
      // Should not happen, but keep retrying
      await sleep(2000);
    } catch (err) {
      const msg = err && err.stack ? err.stack : String(err);
      console.error('[%s] Crash detected (attempt %d). Will relaunch and retry.\n%s', now(), attempt, msg);
      if (isTransientExecutionContextError(err)) {
        console.warn('[%s] Transient execution-context/navigation crash detected; retrying...', now());
      }
      await sleep(4000);
    }
  }
}

main().catch((e) => {
  console.error('[%s] Fatal: %s', now(), e && e.stack ? e.stack : String(e));
  console.error('[%s] Fatal in main bootstrap. Retrying in 10s...', now());
  setTimeout(() => {
    main().catch((err) => {
      console.error('[%s] Fatal(retry): %s', now(), err && err.stack ? err.stack : String(err));
    });
  }, 10000);
});

