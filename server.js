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

function buildCardNumber(first4, last12) {
  const f = String(first4 || '').replace(/\D+/g, '').slice(0, 4);
  const l = String(last12 || '').replace(/\D+/g, '').slice(0, 12);
  return `${f}${l}`.trim();
}

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

    // Navigate: click Transactions in top menu
    console.log('[%s] Clicking Transactions...', now());
    await waitForAnySelector(page, SELECTORS.transactionsLink, 15000);
    await page.click(SELECTORS.transactionsLink[0]).catch(async () => {
      await page.click(SELECTORS.transactionsLink[1]);
    });
    // Proceed as soon as the New Transaction link is available or a navigation occurs
    await Promise.race([
      waitForAnySelector(page, SELECTORS.newTransactionLink, 20000),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
    ]);

    // Click New Transaction
    console.log('[%s] Clicking New Transaction...', now());
    await page.click(SELECTORS.newTransactionLink[0]).catch(async () => {
      await page.click(SELECTORS.newTransactionLink[1]);
    });
    await Promise.race([
      page.waitForSelector('body.transactions_new', { timeout: 20000 }).catch(() => null),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null)
    ]);

    // Wait for New Transaction page based on selectors
    console.log('[%s] Waiting for New Transaction page to load...', now());
    try {
      // Prefer strong body class
      await page.waitForSelector('body.transactions_new', { timeout: 20000 });
    } catch (_) {
      // Fallback to title/header text presence
      await waitForAnySelector(page, [
        'h2',
      ], 20000);
      await page.waitForFunction(() => {
        const h2s = Array.from(document.querySelectorAll('h2'));
        return h2s.some(h => /New Transaction|Transaction Create/i.test((h.textContent || '').trim()));
      }, { timeout: 20000 });
    }

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
        if (form) {
          form.addEventListener('submit', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
        }
      } catch (_) {}
    });

    // Ensure New Transaction inputs are present before filling
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

    // Read first row from Excel and fill the form
    console.log('[%s] Reading first row from input_file.xlsx ...', now());
    let row;
    try {
      row = readFirstRowFromExcel(path.join(process.cwd(), 'input_file.xlsx'));
    } catch (e) {
      console.error('[%s] Excel read error: %s', now(), e.message || e);
      throw e;
    }

    const normalizeKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normalizedRow = Object.keys(row).reduce((acc, k) => {
      acc[normalizeKey(k)] = (row[k] ?? '').toString().trim();
      return acc;
    }, {});
    const valueByHeaders = (headers) => {
      for (const h of headers) {
        if (Object.prototype.hasOwnProperty.call(row, h)) {
          const v = (row[h] ?? '').toString().trim();
          if (v) return v;
        }
      }
      for (const h of headers) {
        const v = normalizedRow[normalizeKey(h)];
        if (v) return v;
      }
      return '';
    };

    const first4Raw = valueByHeaders(['Card first 4', 'Card First 4', 'First 4']);
    const last12Raw = valueByHeaders(['Card last 12', 'Card Last 12', 'Last 12']);
    const first4Digits = String(first4Raw).replace(/\D+/g, '').slice(0, 4);
    const last12Digits = String(last12Raw).replace(/\D+/g, '').slice(0, 12);

    const formValues = {
      merchantAccount: valueByHeaders(['MAIDS', 'Merchant Account', 'Merchant Account ID']),
      amount: valueByHeaders(['Amount']),
      orderId: valueByHeaders(['Reservation ID', 'Order ID']),
      customerFirstName: valueByHeaders(['Hotel Name', 'First Name']),
      cardholderName: 'BOOKING.COM',
      cardNumber: first4Digits && last12Digits ? `${first4Digits}${last12Digits}` : (first4Digits || last12Digits || ''),
      expirationDate: valueByHeaders(['Expiry', 'Expiration', 'Expiration Date (MM/YYYY)', 'Expiration Date', 'Exp Date']).replace(/\s+/g, ''),
      cvv: valueByHeaders(['CVV', 'Security Code', 'CVV2']),
      billingPostalCode: '10118',
      billingCompany: '',
      billingCountryName: 'United States of America'
    };

    console.log('[%s] Filling New Transaction form...', now());
    // Merchant Account (singleplete text input)
    if (formValues.merchantAccount) {
      await page.focus(FORM_SELECTORS.merchantAccount);
      await page.click(FORM_SELECTORS.merchantAccount, { clickCount: 3 });
      await page.type(FORM_SELECTORS.merchantAccount, formValues.merchantAccount, { delay: 25 });
      // Let autocomplete settle, then blur without submitting
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

    // Cardholder Name (fixed)
    await page.focus(FORM_SELECTORS.cardholderName);
    await page.click(FORM_SELECTORS.cardholderName, { clickCount: 3 });
    await page.type(FORM_SELECTORS.cardholderName, formValues.cardholderName, { delay: 10 });

    // Credit Card Number (ensure both parts typed)
    if (formValues.cardNumber) {
      await page.focus(FORM_SELECTORS.cardNumber);
      await page.click(FORM_SELECTORS.cardNumber, { clickCount: 3 });
      await page.type(FORM_SELECTORS.cardNumber, formValues.cardNumber, { delay: 10 });
      // Verify and complete if only partially typed
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

    // Billing Postal Code (fixed)
    await page.focus(FORM_SELECTORS.billingPostalCode);
    await page.click(FORM_SELECTORS.billingPostalCode, { clickCount: 3 });
    await page.type(FORM_SELECTORS.billingPostalCode, formValues.billingPostalCode, { delay: 10 });

    // Billing First Name (fixed "Booking.com")
    try {
      await page.focus(FORM_SELECTORS.billingFirstName);
      await page.click(FORM_SELECTORS.billingFirstName, { clickCount: 3 });
      await page.type(FORM_SELECTORS.billingFirstName, 'Booking.com', { delay: 10 });
    } catch (_) {}

    // Clear Billing Company
    try {
      await page.$eval(FORM_SELECTORS.billingCompany, (el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } catch (_) {}

    // Country Name select
    if (formValues.billingCountryName) {
      await page.select(FORM_SELECTORS.billingCountryName, formValues.billingCountryName).catch(async () => {
        // Fallback: set value via evaluate for custom select wrappers
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, FORM_SELECTORS.billingCountryName, formValues.billingCountryName);
      });
    }

    // Skip Premium Fraud Checking
    const skipChecked = await page.$eval(FORM_SELECTORS.skipPremiumFraudCheckbox, (el) => el.checked).catch(() => false);
    if (!skipChecked) {
      try {
        await page.$eval(FORM_SELECTORS.skipPremiumFraudCheckbox, (el) => el.scrollIntoView({ block: 'center' }));
      } catch (_) {}
      await page.click(FORM_SELECTORS.skipPremiumFraudCheckbox).catch(() => {});
      // Force-set checked if needed
      const stillUnchecked = await page.$eval(FORM_SELECTORS.skipPremiumFraudCheckbox, (el) => el.checked).catch(() => false);
      if (!stillUnchecked) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, FORM_SELECTORS.skipPremiumFraudCheckbox);
      }
    }

    console.log('[%s] Form filled. Pausing here for manual review. Close the browser to end.', now());
    // Keep the browser open for review; do not submit or exit automatically
    await new Promise(() => {});
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


