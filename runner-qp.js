/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');

require('dotenv').config();

const app = express();

const requestedPort = Number(process.env.PORT || 3001);
// qp.js uses a local OAuth callback server on :3000; avoid collisions
const PORT = requestedPort === 3000 ? 3001 : requestedPort;

const projectRoot = __dirname;
const publicDir = path.join(projectRoot, 'public');
const uploadsDir = path.join(projectRoot, 'uploads');
const tokenPath = path.join(projectRoot, '.qp_gmail_token.json');

// Ensure dirs exist
try { fs.mkdirSync(publicDir, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_) {}

// Serve QP page as default; still allow direct access to static assets
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'qp.html'));
});
app.use(express.static(publicDir, { index: false }));
app.use(express.urlencoded({ extended: true }));

// Configure disk storage to save as /uploads/<originalName>_<timestamp>.xlsx
const storage = multer.diskStorage({
  destination: function destination(req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function filename(req, file, cb) {
    const original = file.originalname || 'input_file.xlsx';
    const ext = path.extname(original) || '.xlsx';
    const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'input_file';
    const ts = Date.now();
    cb(null, `${base}_${ts}${ext}`);
  }
});
const upload = multer({ storage });

// SSE log streaming
/** @type {Set<import('http').ServerResponse>} */
const clients = new Set();
/** @type {{ child: import('child_process').ChildProcess | null, uploadedFile: string | null, outputFile: string | null, downloadName: string | null, killTimer?: NodeJS.Timeout }} */
const current = { child: null, uploadedFile: null, outputFile: null, downloadName: null };

function broadcast(message) {
  const line = typeof message === 'string' ? message : String(message);
  for (const res of clients) {
    try {
      res.write(`data: ${line.replace(/\n/g, '\\n')}\n\n`);
    } catch (_) { /* ignore */ }
  }
}

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  clients.add(res);
  const hb = setInterval(() => {
    try { res.write(':\n\n'); } catch (_) {}
  }, 15000);
  req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
  });
});

function getOauth2Client() {
  const { google } = require('googleapis');
  const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
  const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET in .env');
  }
  const redirectUri = `http://localhost:${PORT}/oauth2callback`;
  return new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, redirectUri);
}

app.get('/oauth/status', (req, res) => {
  res.json({ ok: true, tokenPresent: fs.existsSync(tokenPath) });
});

app.get('/oauth/url', (req, res) => {
  try {
    const oAuth2Client = getOauth2Client();
    const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'];
    const url = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    });
    broadcast('[UI] Generated Gmail OAuth URL.');
    res.json({ ok: true, url });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).send('Missing "code" query parameter.');
    const oAuth2Client = getOauth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    broadcast('[UI] Gmail OAuth complete. Token saved to .qp_gmail_token.json');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end([
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>Authorization complete</title></head>',
      '<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;">',
      '<h2>Authorization complete</h2>',
      '<p>You can close this tab and return to the Quantum Pay UI.</p>',
      '</body></html>',
    ].join(''));
  } catch (e) {
    broadcast(`[UI] Gmail OAuth failed: ${e.message || String(e)}`);
    return res.status(500).send(`Auth failed: ${e.message || String(e)}`);
  }
});

app.post('/start', upload.single('inputFile'), (req, res) => {
  try {
    if (current.child && !current.child.killed) {
      return res.status(409).json({ ok: false, error: 'A run is already in progress' });
    }
    const review = (req.body.review || 'review').toLowerCase(); // 'review' | 'no-review'

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }

    const uploadedPath = req.file.path;
    current.uploadedFile = uploadedPath;

    const originalBase = path.basename(uploadedPath, path.extname(uploadedPath));
    current.downloadName = `${originalBase}_qp_processed.xlsx`;

    // qp.js expects current_list_qp_automation.xlsx in cwd; keep cwd=projectRoot so Gmail token persists
    const qpInputPath = path.join(projectRoot, 'current_list_qp_automation.xlsx');
    fs.copyFileSync(uploadedPath, qpInputPath);
    current.outputFile = qpInputPath;

    broadcast(`[UI] Received file: ${path.basename(uploadedPath)}`);
    broadcast(`[UI] Copied to: ${path.basename(qpInputPath)}`);

    const args = [path.join(projectRoot, 'qp.js')];
    if (review === 'no-review') args.push('--no-review'); else args.push('--review');

    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    broadcast(`[UI] Started process pid=${child.pid}`);
    current.child = child;
    if (current.killTimer) { clearTimeout(current.killTimer); current.killTimer = undefined; }

    const pipe = (stream, tag) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          broadcast(`[${tag}] ${line}`);
        }
      });
    };
    pipe(child.stdout, 'RUN');
    pipe(child.stderr, 'ERR');

    child.on('close', (code) => {
      broadcast(`[UI] Process exited with code ${code}`);
      current.child = null;
      if (current.killTimer) { clearTimeout(current.killTimer); current.killTimer = undefined; }
    });

    return res.json({ ok: true, pid: child.pid, message: 'Process started' });
  } catch (e) {
    console.error('Failed to start process:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/stop', (req, res) => {
  try {
    const child = current.child;
    if (!child || child.killed) {
      return res.status(400).json({ ok: false, error: 'No active process' });
    }
    broadcast(`[UI] Stopping process pid=${child.pid} ...`);
    try { child.kill('SIGINT'); } catch (_) {}
    current.killTimer = setTimeout(() => {
      if (current.child && !current.child.killed) {
        broadcast('[UI] Force killing process...');
        try { current.child.kill('SIGKILL'); } catch (_) {}
      }
    }, 7000);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/status', (req, res) => {
  const running = Boolean(current.child && !current.child.killed);
  const pid = running ? current.child.pid : null;
  const file = current.outputFile ? path.basename(current.outputFile) : null;
  res.json({ ok: true, running, pid, file });
});

app.get('/download', (req, res) => {
  if (!current.outputFile || !fs.existsSync(current.outputFile)) {
    return res.status(404).send('No file available');
  }
  const downloadName = current.downloadName || path.basename(current.outputFile);
  return res.download(current.outputFile, downloadName);
});

app.get('/download-autosave', (req, res) => {
  const qpInputPath = path.join(projectRoot, 'current_list_qp_automation.xlsx');
  if (!fs.existsSync(qpInputPath)) return res.status(404).send('No auto-saved file available');
  return res.download(qpInputPath, 'current_list_qp_automation.xlsx');
});

app.listen(PORT, () => {
  if (requestedPort === 3000) {
    console.warn('PORT=3000 would conflict with Gmail OAuth callback. Using port 3001 instead.');
  }
  console.log(`QP UI available at http://localhost:${PORT}`);
});

