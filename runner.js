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

// Ensure public dir exists
try { fs.mkdirSync(publicDir, { recursive: true }); } catch (_) {}

app.use(express.static(publicDir));

const upload = multer({ dest: path.join(projectRoot, 'uploads') });

app.post('/start', upload.single('inputFile'), (req, res) => {
  try {
    const brand = (req.body.brand || 'booking').toLowerCase(); // 'booking' | 'agoda'
    const review = (req.body.review || 'review').toLowerCase(); // 'review' | 'no-review'

    // Save uploaded file as input_file.xlsx at project root
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }
    const destPath = path.join(projectRoot, 'input_file.xlsx');
    fs.renameSync(req.file.path, destPath);

    // Build args
    const args = [path.join(projectRoot, 'server.js')];
    if (brand === 'agoda') args.push('--agoda'); else args.push('--booking');
    if (review === 'no-review') args.push('--no-review'); else args.push('--review');

    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });

    return res.json({ ok: true, pid: child.pid, message: 'Process started' });
  } catch (e) {
    console.error('Failed to start process:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`UI available at http://localhost:${PORT}`);
});


