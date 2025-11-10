/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const projectRoot = __dirname;
const publicDir = path.join(projectRoot, 'public');
const uploadsDir = path.join(projectRoot, 'uploads');

// Ensure public dir exists
try { fs.mkdirSync(publicDir, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_) {}

app.use(express.static(publicDir));
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
/** @type {{ child: import('child_process').ChildProcess | null, file: string | null, killTimer?: NodeJS.Timeout }} */
const current = { child: null, file: null };
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
  // heartbeat
  const hb = setInterval(() => {
    try { res.write(':\n\n'); } catch (_) {}
  }, 15000);
  req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
  });
});

app.post('/start', upload.single('inputFile'), (req, res) => {
  try {
    if (current.child && !current.child.killed) {
      return res.status(409).json({ ok: false, error: 'A run is already in progress' });
    }
    const brand = (req.body.brand || 'booking').toLowerCase(); // 'booking' | 'agoda'
    const review = (req.body.review || 'review').toLowerCase(); // 'review' | 'no-review'

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }
    const uploadedPath = req.file.path; // already saved as /uploads/<name>_<ts>.xlsx
    broadcast(`[UI] Received file: ${path.basename(uploadedPath)}`);
    current.file = uploadedPath;

    // Build args
    const args = [path.join(projectRoot, 'server.js')];
    if (brand === 'agoda') args.push('--agoda'); else args.push('--booking');
    if (review === 'no-review') args.push('--no-review'); else args.push('--review');

    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, INPUT_XLSX: uploadedPath },
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

// Stop the running process without stopping the UI server
app.post('/stop', (req, res) => {
  try {
    const child = current.child;
    if (!child || child.killed) {
      return res.status(400).json({ ok: false, error: 'No active process' });
    }
    broadcast(`[UI] Stopping process pid=${child.pid} ...`);
    try {
      child.kill('SIGINT');
    } catch (e) {
      // ignore
    }
    // Fallback SIGKILL after 7s if still alive
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

// Status endpoint for UI to discover running state and file
app.get('/status', (req, res) => {
  const running = Boolean(current.child && !current.child.killed);
  const pid = running ? current.child.pid : null;
  const file = current.file ? path.basename(current.file) : null;
  res.json({ ok: true, running, pid, file });
});

// Download current working file
app.get('/download', (req, res) => {
  if (!current.file || !fs.existsSync(current.file)) {
    return res.status(404).send('No file available');
  }
  res.download(current.file, path.basename(current.file));
});

app.listen(PORT, () => {
  console.log(`UI available at http://localhost:${PORT}`);
});


