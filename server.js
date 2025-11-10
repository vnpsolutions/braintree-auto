/*
  Braintree login helper driven by Puppeteer.
  Steps:
  1) Open Chromium (non-headless)
  2) Navigate to https://www.braintreegateway.com/login
  3) Verify login page selectors present
  4) Wait for user to manually enter username/password and submit
  5) If OTP page appears, wait for user to enter OTP
  6) Detect arrival at main dashboard
  7) Take a screenshot and exit

  Note: This script uses dynamic import for Puppeteer to support ESM-only versions.
  Install dependency first if missing: npm i puppeteer
*/

/* eslint-disable no-console */

const path = require('path');
const fs = require('fs');

// Configurable timeouts (override with env vars if desired)
const LOGIN_PAGE_LOAD_TIMEOUT_MS = Number(process.env.LOGIN_PAGE_LOAD_TIMEOUT_MS || 30000);
const POST_LOGIN_WAIT_TIMEOUT_MS = Number(process.env.POST_LOGIN_WAIT_TIMEOUT_MS || 10 * 60 * 1000); // 10 minutes
const OTP_WAIT_TIMEOUT_MS = Number(process.env.OTP_WAIT_TIMEOUT_MS || 10 * 60 * 1000); // 10 minutes

// Brand selection via CLI: --agoda or --booking (default booking)
const BRAND = process.argv.includes('--agoda') ? 'agoda' : 'booking';
const hasFlag = (flag) => process.argv.includes(flag);
// Review mode: explicit --review, or default for agoda unless --no-review is passed
const REVIEW_MODE = hasFlag('--review') || (BRAND === 'agoda' && !hasFlag('--no-review'));
// Status page wait timeout (longer for agoda)
const STATUS_WAIT_TIMEOUT_MS = Number(process.env.STATUS_WAIT_TIMEOUT_MS || (BRAND === 'agoda' ? 120000 : 60000));
// Input Excel file path (can be injected by UI runner); fallback to ./input_file.xlsx
const INPUT_XLSX = (process.env.INPUT_XLSX && fs.existsSync(process.env.INPUT_XLSX))
  ? process.env.INPUT_XLSX
  : path.join(process.cwd(), 'input_file.xlsx');

// Stable selectors derived from saved HTML templates in html_templates_for_selectors/
const SELECTORS = {
  login: [
    'form[action="/session"]',
    '#login',
    '#password',
    'input.login-submit-button'
  ],
  otp: [
    'form[action="/session/two_factor"]',
    'input[name="code"]',
    'h2.unified-login__title'
  ],
  dashboard: [
    'input#q.unified-panel-search_input',
    'a[href*="/transactions/advanced_search"]',
    'h4.graph-title'
  ],
  transactionsLink: [
    'a[onclick*="trackClick(\'transactions\')"]',
    'a[href*="/transactions/advanced_search"]'
  ],
  newTransactionLink: [
    'a[onclick*="trackClick(\'new_transaction\')"]',
    'a[href$="/transactions/new"]'
  ],
  newTransactionPage: [
    'body.transactions_new',
    'h2:has-text("New Transaction")',
    'h2:has-text("Transaction Create")'
  ],
  submitPage: [
    'body.transactions_show',
    'span.transaction-status',
    'h2:has-text("Transaction Detail")'
  ]
};

const FORM_SELECTORS = {
  merchantAccount: '#transaction_merchant_account_id',
  amount: '#transaction_amount',
  orderId: '#transaction_order_id',
  customerFirstName: '#transaction_customer_first_name',
  cardholderName: '#transaction_credit_card_cardholder_name',
  cardNumber: '#transaction_credit_card_number',
  expirationDate: '#transaction_credit_card_expiration_date',
  cvv: '#transaction_credit_card_cvv',
  billingPostalCode: '#transaction_billing_postal_code',
  billingCompany: '#transaction_billing_company',
  billingFirstName: '#transaction_billing_first_name',
  billingStreet: '#transaction_billing_street_address',
  billingRegion: '#transaction_billing_region',
  billingCountryName: '#transaction_billing_country_name',
  skipPremiumFraudCheckbox: '#transaction_options_skip_advanced_fraud_checking'
};

function readFirstRowFromExcel(filePath) {
  let xlsx;
  try {
    // eslint-disable-next-line global-require
    xlsx = require('xlsx');
  } catch (e) {
    throw new Error('Missing dependency: xlsx. Install with "npm i xlsx"');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
  const wb = xlsx.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) {
    throw new Error('Excel sheet is empty');
  }
  return rows[0];
}

function readAllRowsFromExcel(filePath) {
  // eslint-disable-next-line global-require
  const xlsx = require('xlsx');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
  const wb = xlsx.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(ws, { defval: '' });
}

function buildCardNumber(first4, last12) {
  const f = String(first4 || '').replace(/\D+/g, '').slice(0, 4);
  const l = String(last12 || '').replace(/\D+/g, '').slice(0, 12);
  return `${f}${l}`.trim();
}

function writeStatusToExcel(filePath, rowIndexZeroBased, statusValue) {
  // eslint-disable-next-line global-require
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const range = xlsx.utils.decode_range(ws['!ref']);
  const headerRow = range.s.r;
  let statusCol = null;
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = xlsx.utils.encode_cell({ r: headerRow, c });
    const cell = ws[addr];
    const txt = cell ? String(cell.v ?? cell.w ?? '').trim().toLowerCase() : '';
    if (txt === 'status') { statusCol = c; break; }
  }
  if (statusCol === null) {
    statusCol = range.e.c + 1;
    const headerAddr = xlsx.utils.encode_cell({ r: headerRow, c: statusCol });
    ws[headerAddr] = { t: 's', v: 'STATUS' };
    range.e.c = statusCol;
    ws['!ref'] = xlsx.utils.encode_range(range);
  }
  const targetRow = headerRow + 1 + rowIndexZeroBased;
  const targetAddr = xlsx.utils.encode_cell({ r: targetRow, c: statusCol });
  ws[targetAddr] = { t: 's', v: statusValue };
  if (targetRow > range.e.r) {
    range.e.r = targetRow;
    ws['!ref'] = xlsx.utils.encode_range(range);
  }
  xlsx.writeFile(wb, filePath);
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatusText(page, timeoutMs) {
  const start = Date.now();
  let lastSeen = '';
  /* Poll until a non-empty status text appears or timeout */
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const text = await page.evaluate(() => {
        const el = document.querySelector('span.transaction-status, span[class*="transaction-status"]');
        return el ? (el.textContent || '').trim() : '';
      });
      if (text) return text;
      lastSeen = text;
    } catch (e) {
      // ignore transient errors during navigation/paint
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for transaction status after ${timeoutMs}ms (last seen: "${lastSeen}")`);
    }
    await sleep(1000);
  }
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

async function waitForAnySelector(page, selectors, timeoutMs) {
  return page.waitForFunction(
    (sels) => sels.some((sel) => document.querySelector(sel)),
    { timeout: timeoutMs },
    selectors
  );
}

async function waitForText(page, selector, includesText, timeoutMs) {
  return page.waitForFunction(
    (sel, txt) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const content = (el.textContent || '').trim();
      return content.includes(txt);
    },
    { timeout: timeoutMs },
    selector,
    includesText
  );
}

function raceStages(page, stages, timeoutMs) {
  const promises = stages.map((stage) => {
    if (stage.type === 'selectors') {
      return waitForAnySelector(page, stage.selectors, timeoutMs).then(() => stage.name);
    }
    if (stage.type === 'text') {
      return waitForText(page, stage.selector, stage.text, timeoutMs).then(() => stage.name);
    }
    return Promise.reject(new Error('Unsupported stage type'));
  });
  return Promise.race(promises);
}

async function main() {
  const puppeteer = await importPuppeteer();

  console.log('[%s] Launching Chromium (non-headless)...', now());
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-blink-features=AutomationControlled",
      "--disable-extensions",
      // Additional stealth args to avoid detection
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pings",
      "--password-store=basic",
      "--use-mock-keychain",
      "--excludeSwitches=enable-automation",
      "--disable-automation",
      "--disable-infobars"
    ]
  });

  let exitCode = 0;
  try {
    const page = await browser.newPage();

    const loginUrl = 'https://www.braintreegateway.com/login';
    console.log('[%s] Navigating to %s ...', now(), loginUrl);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('[%s] Verifying login page loaded (selectors from login_selectors.html)...', now());
    await waitForAnySelector(page, SELECTORS.login, LOGIN_PAGE_LOAD_TIMEOUT_MS);
    console.log('[%s] Login page detected. Please enter username and password manually, then submit.', now());

    console.log('[%s] Waiting for either OTP page or dashboard...', now());
    const firstStage = await raceStages(
      page,
      [
        { name: 'otp', type: 'selectors', selectors: SELECTORS.otp },
        { name: 'dashboard', type: 'selectors', selectors: SELECTORS.dashboard }
      ],
      POST_LOGIN_WAIT_TIMEOUT_MS
    );

    if (firstStage === 'otp') {
      // Confirm OTP title text for extra robustness
      await waitForText(page, 'h2.unified-login__title', 'Two-Factor Authentication', 5000).catch(() => {});
      console.log('[%s] OTP page detected. Please enter your one-time code manually.', now());

      console.log('[%s] Waiting for dashboard after OTP...', now());
      await waitForAnySelector(page, SELECTORS.dashboard, OTP_WAIT_TIMEOUT_MS);
    } else {
      console.log('[%s] Dashboard detected (no OTP required).', now());
    }

    console.log('[%s] Main dashboard confirmed (selectors from main_dashboard_selectors.html).', now());

    // Helper to navigate to New Transaction page from any state where the top nav is visible
    async function goToNewTransaction() {
      console.log('[%s] Navigating to New Transaction...', now());
      await waitForAnySelector(page, SELECTORS.transactionsLink, 20000);
      await page.click(SELECTORS.transactionsLink[0]).catch(async () => { await page.click(SELECTORS.transactionsLink[1]); });
      await Promise.race([
        waitForAnySelector(page, SELECTORS.newTransactionLink, 20000),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
      ]);
      await page.click(SELECTORS.newTransactionLink[0]).catch(async () => { await page.click(SELECTORS.newTransactionLink[1]); });
      await Promise.race([
        page.waitForSelector('body.transactions_new', { timeout: 20000 }).catch(() => null),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
      ]);
      try {
        await page.waitForSelector('body.transactions_new', { timeout: 20000 });
      } catch (_) {
        await waitForAnySelector(page, ['h2'], 20000);
        await page.waitForFunction(() => {
          const h2s = Array.from(document.querySelectorAll('h2'));
          return h2s.some(h => /New Transaction|Transaction Create/i.test((h.textContent || '').trim()));
        }, { timeout: 20000 });
      }
    }

    // Read all rows and iterate
    const inputPath = INPUT_XLSX;
    let rows;
    try {
      rows = readAllRowsFromExcel(inputPath);
    } catch (e) {
      console.error('[%s] Excel read error: %s', now(), e.message || e);
      throw e;
    }

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];

      // Skip if STATUS already present/non-empty
      const statusCell = (row.STATUS ?? row.Status ?? row.status ?? '').toString().trim();
      if (statusCell) {
        console.log('[%s] Row %d already has STATUS="%s". Skipping.', now(), idx + 1, statusCell);
        continue;
      }

      // Build helpers for this row and validate CVV length >= 3
      const normalizeKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const normalizedRow = Object.keys(row).reduce((acc, k) => { acc[normalizeKey(k)] = (row[k] ?? '').toString().trim(); return acc; }, {});
      const valueByHeaders = (headers) => {
        for (const h of headers) { if (Object.prototype.hasOwnProperty.call(row, h)) { const v = (row[h] ?? '').toString().trim(); if (v) return v; } }
        for (const h of headers) { const v = normalizedRow[normalizeKey(h)]; if (v) return v; }
        return '';
      };
      const cvvRawEarly = valueByHeaders(['CVV', 'Security Code', 'CVV2']);
      const cvvDigitsEarly = String(cvvRawEarly || '').replace(/\D+/g, '');
      if (cvvDigitsEarly.length < 3) {
        console.log('[%s] Row %d CVV has less than 3 digits. Skipping.', now(), idx + 1);
        continue;
      }

      await goToNewTransaction();

      // Prevent accidental submit via Enter while we fill fields
      await page.evaluate(() => {
        try {
          const preventEnter = (e) => {
            if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
              e.preventDefault();
              e.stopPropagation();
            }
          };
          window.addEventListener('keydown', preventEnter, true);
          const form = document.getElementById('transaction_form');
          if (form) { form.addEventListener('submit', (e) => { e.preventDefault(); e.stopPropagation(); }, true); }
        } catch (_) {}
      });

      // Ensure critical inputs
      try {
        await page.waitForSelector(FORM_SELECTORS.merchantAccount, { timeout: 30000 });
      } catch (e) {
        console.warn('[%s] Merchant Account input not immediately available, adding brief delay...', now());
        await sleep(1500);
        await page.waitForSelector(FORM_SELECTORS.merchantAccount, { timeout: 30000 });
      }
      await Promise.all([
        page.waitForSelector(FORM_SELECTORS.amount, { timeout: 30000 }).catch(() => null),
        page.waitForSelector(FORM_SELECTORS.orderId, { timeout: 30000 }).catch(() => null),
        page.waitForSelector(FORM_SELECTORS.cardNumber, { timeout: 30000 }).catch(() => null),
      ]);
      await sleep(400);

      const first4Raw = valueByHeaders(['Card first 4', 'Card First 4', 'First 4']);
      const last12Raw = valueByHeaders(['Card last 12', 'Card Last 12', 'Last 12']);
      const first4Digits = String(first4Raw).replace(/\D+/g, '').slice(0, 4);
      const last12Digits = String(last12Raw).replace(/\D+/g, '').slice(0, 12);

      const formValues = {
        merchantAccount: valueByHeaders(['MAIDS', 'Merchant Account', 'Merchant Account ID']),
        amount: valueByHeaders(['Amount']),
        orderId: valueByHeaders(['Reservation ID', 'Order ID']),
        customerFirstName: valueByHeaders(['Hotel Name', 'First Name']),
        cardholderName: BRAND === 'agoda' ? 'Agoda Ltd.' : 'BOOKING.COM',
        cardNumber: first4Digits && last12Digits ? `${first4Digits}${last12Digits}` : (first4Digits || last12Digits || ''),
        expirationDate: valueByHeaders(['Expiry', 'Expiration', 'Expiration Date (MM/YYYY)', 'Expiration Date', 'Exp Date']).replace(/\s+/g, ''),
        cvv: valueByHeaders(['CVV', 'Security Code', 'CVV2']),
        billingPostalCode: BRAND === 'agoda' ? '80525' : '10118',
        billingCompany: '',
        billingCountryName: 'United States of America'
      };

      console.log('[%s] Filling New Transaction form for row %d...', now(), idx + 1);
      // Merchant Account
      if (formValues.merchantAccount) {
        await page.focus(FORM_SELECTORS.merchantAccount);
        await page.click(FORM_SELECTORS.merchantAccount, { clickCount: 3 });
        await page.type(FORM_SELECTORS.merchantAccount, formValues.merchantAccount, { delay: 25 });
        await sleep(250);
        await page.keyboard.press('Tab').catch(() => {});
      }
      // Amount
      if (formValues.amount) {
        await page.focus(FORM_SELECTORS.amount);
        await page.click(FORM_SELECTORS.amount, { clickCount: 3 });
        await page.type(FORM_SELECTORS.amount, formValues.amount, { delay: 10 });
      }
      // Order ID
      if (formValues.orderId) {
        await page.focus(FORM_SELECTORS.orderId);
        await page.click(FORM_SELECTORS.orderId, { clickCount: 3 });
        await page.type(FORM_SELECTORS.orderId, formValues.orderId, { delay: 10 });
      }
      // Customer First Name
      if (formValues.customerFirstName) {
        await page.focus(FORM_SELECTORS.customerFirstName);
        await page.click(FORM_SELECTORS.customerFirstName, { clickCount: 3 });
        await page.type(FORM_SELECTORS.customerFirstName, formValues.customerFirstName, { delay: 10 });
      }
      // Cardholder Name
      await page.focus(FORM_SELECTORS.cardholderName);
      await page.click(FORM_SELECTORS.cardholderName, { clickCount: 3 });
      await page.type(FORM_SELECTORS.cardholderName, formValues.cardholderName, { delay: 10 });
      // Card Number
      if (formValues.cardNumber) {
        await page.focus(FORM_SELECTORS.cardNumber);
        await page.click(FORM_SELECTORS.cardNumber, { clickCount: 3 });
        await page.type(FORM_SELECTORS.cardNumber, formValues.cardNumber, { delay: 10 });
        try {
          const typed = await page.$eval(FORM_SELECTORS.cardNumber, (el) => (el.value || ''));
          const typedDigits = String(typed).replace(/\D+/g, '');
          const expectedDigits = `${first4Digits}${last12Digits}`;
          if (expectedDigits && typedDigits.length < expectedDigits.length) {
            const remaining = expectedDigits.slice(typedDigits.length);
            await page.type(FORM_SELECTORS.cardNumber, `${remaining}`, { delay: 10 });
          }
        } catch (_) {}
      }
      // Expiration Date
      if (formValues.expirationDate) {
        await page.focus(FORM_SELECTORS.expirationDate);
        await page.click(FORM_SELECTORS.expirationDate, { clickCount: 3 });
        await page.type(FORM_SELECTORS.expirationDate, formValues.expirationDate, { delay: 10 });
      }
      // CVV
      if (formValues.cvv) {
        await page.focus(FORM_SELECTORS.cvv);
        await page.click(FORM_SELECTORS.cvv, { clickCount: 3 });
        await page.type(FORM_SELECTORS.cvv, formValues.cvv, { delay: 10 });
      }
      // Postal Code
      await page.focus(FORM_SELECTORS.billingPostalCode);
      await page.click(FORM_SELECTORS.billingPostalCode, { clickCount: 3 });
      await page.type(FORM_SELECTORS.billingPostalCode, formValues.billingPostalCode, { delay: 10 });
      // Billing First Name (brand-specific)
      try {
        await page.focus(FORM_SELECTORS.billingFirstName);
        await page.click(FORM_SELECTORS.billingFirstName, { clickCount: 3 });
        await page.type(FORM_SELECTORS.billingFirstName, BRAND === 'agoda' ? 'Agoda Company Pte Ltd.' : 'Booking.com', { delay: 10 });
      } catch (_) {}

      // Agoda-only fields: Street Address and Region
      if (BRAND === 'agoda') {
        try {
          await page.focus(FORM_SELECTORS.billingStreet);
          await page.click(FORM_SELECTORS.billingStreet, { clickCount: 3 });
          await page.type(FORM_SELECTORS.billingStreet, '155 E. Boardwalk #490', { delay: 10 });
        } catch (_) {}
        try {
          await page.focus(FORM_SELECTORS.billingRegion);
          await page.click(FORM_SELECTORS.billingRegion, { clickCount: 3 });
          await page.type(FORM_SELECTORS.billingRegion, 'Fort Collins, CO', { delay: 10 });
        } catch (_) {}
      }
      // Clear Billing Company
      try {
        await page.$eval(FORM_SELECTORS.billingCompany, (el) => {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } catch (_) {}
      // Country Name
      if (formValues.billingCountryName) {
        await page.select(FORM_SELECTORS.billingCountryName, formValues.billingCountryName).catch(async () => {
          await page.evaluate((sel, val) => { const el = document.querySelector(sel); if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); } }, FORM_SELECTORS.billingCountryName, formValues.billingCountryName);
        });
      }
      // Skip Premium Fraud Checking
      const skipChecked = await page.$eval(FORM_SELECTORS.skipPremiumFraudCheckbox, (el) => el.checked).catch(() => false);
      if (!skipChecked) {
        try { await page.$eval(FORM_SELECTORS.skipPremiumFraudCheckbox, (el) => el.scrollIntoView({ block: 'center' })); } catch (_) {}
        await page.click(FORM_SELECTORS.skipPremiumFraudCheckbox).catch(() => {});
        const stillUnchecked = await page.$eval(FORM_SELECTORS.skipPremiumFraudCheckbox, (el) => el.checked).catch(() => false);
        if (!stillUnchecked) {
          await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); } }, FORM_SELECTORS.skipPremiumFraudCheckbox);
        }
      }

      // Submit with settle wait (disabled in REVIEW_MODE)
      if (REVIEW_MODE) {
        console.log('[%s] REVIEW MODE enabled. Pausing after fill for manual review on row %d. Press Ctrl+C to exit.', now(), idx + 1);
        await new Promise(() => {});
      } else {
        console.log('[%s] Row %d filled. Submitting in 2 seconds...', now(), idx + 1);
        await sleep(2000);
        await page.evaluate(() => { const form = document.getElementById('transaction_form'); const btn = document.getElementById('create_transaction_btn'); if (form && typeof form.submit === 'function') { form.submit(); } else if (btn) { btn.click(); } });
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
          page.waitForSelector('body.transactions_show', { timeout: 60000 }).catch(() => null)
        ]);
        await waitForAnySelector(page, SELECTORS.submitPage, 30000);
      }

      if (!REVIEW_MODE) {
        // Ensure submit page is fully ready and capture status robustly
        try {
          await waitForAnySelector(page, SELECTORS.submitPage, STATUS_WAIT_TIMEOUT_MS);
        } catch (_) {}
        let statusText = '';
        try {
          statusText = await waitForStatusText(page, STATUS_WAIT_TIMEOUT_MS);
        } catch (e) {
          console.warn('[%s] Status text not ready within timeout. Retrying once...', now());
          await sleep(2000);
          statusText = await waitForStatusText(page, STATUS_WAIT_TIMEOUT_MS).catch(() => '');
        }
        console.log('[%s] Row %d status: %s', now(), idx + 1, statusText || 'N/A');
        try { writeStatusToExcel(inputPath, idx, statusText || ''); console.log('[%s] STATUS written to Excel for row %d.', now(), idx + 1); } catch (e) { console.warn('[%s] Failed to write STATUS for row %d: %s', now(), idx + 1, e && e.message ? e.message : String(e)); }

        // Screenshot
        // const screenshotsDir = path.join(process.cwd(), 'screenshots');
        // try { fs.mkdirSync(screenshotsDir, { recursive: true }); } catch (_) {}
        // const submitShot = path.join(screenshotsDir, `submit_row${idx + 1}_${Date.now()}.png`);
        // await page.screenshot({ path: submitShot, fullPage: true });

        // Back to Transactions for next iteration
        await waitForAnySelector(page, SELECTORS.transactionsLink, 15000);
        await page.click(SELECTORS.transactionsLink[0]).catch(async () => { await page.click(SELECTORS.transactionsLink[1]); });
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
          waitForAnySelector(page, SELECTORS.newTransactionLink, 30000).catch(() => null)
        ]);
      }
    }

    console.log('[%s] All rows processed successfully. Closing browser...', now());
  } catch (err) {
    exitCode = 1;
    console.error('[%s] Error: %s', now(), err && err.stack ? err.stack : String(err));
  } finally {
    console.log('[%s] Closing browser...', now());
    try { await browser.close(); } catch (e) { /* ignore */ }
    process.exit(exitCode);
  }
}

main().catch((e) => {
  console.error('[%s] Fatal: %s', now(), e && e.stack ? e.stack : String(e));
  process.exit(1);
});


