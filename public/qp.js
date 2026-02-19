const form = document.getElementById('start-form');
const statusEl = document.getElementById('status');
const authStatusEl = document.getElementById('authStatus');
const startBtn = document.getElementById('startBtn');
const downloadBtn = document.getElementById('downloadBtn');
const authBtn = document.getElementById('authBtn');
const logEl = document.getElementById('log');
let running = false;

async function refreshStatus() {
  try {
    const res = await fetch('/status');
    const json = await res.json();
    if (json.ok) {
      running = Boolean(json.running);
      startBtn.textContent = running ? 'Stop' : 'Start';
      if (json.file) {
        downloadBtn.setAttribute('href', '/download');
        downloadBtn.removeAttribute('aria-disabled');
      } else {
        downloadBtn.setAttribute('aria-disabled', 'true');
      }
    }
  } catch (_) {}

  try {
    const res = await fetch('/oauth/status');
    const json = await res.json();
    if (json.ok) {
      authStatusEl.textContent = json.tokenPresent
        ? 'Gmail OAuth: token found (OTP auto-solve enabled).'
        : 'Gmail OAuth: not authorized yet.';
    }
  } catch (_) {}
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  logEl.textContent = '';
  startBtn.disabled = true;
  try {
    if (!running) {
      startBtn.textContent = 'Starting...';
      const data = new FormData(form);
      const res = await fetch('/start', { method: 'POST', body: data });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Failed to start');
      statusEl.textContent = `Started process (pid ${json.pid}).`;
      running = true;
      startBtn.textContent = 'Stop';
      downloadBtn.removeAttribute('aria-disabled');
    } else {
      startBtn.textContent = 'Stopping...';
      const res = await fetch('/stop', { method: 'POST' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Failed to stop');
      statusEl.textContent = 'Stop signal sent.';
      running = false;
      startBtn.textContent = 'Start';
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message || String(err)}`;
  } finally {
    startBtn.disabled = false;
  }
});

authBtn.addEventListener('click', async () => {
  authBtn.disabled = true;
  try {
    statusEl.textContent = '';
    const res = await fetch('/oauth/url');
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Failed to create OAuth URL');
    window.open(json.url, '_blank', 'noopener');
    statusEl.textContent = 'Opened Gmail OAuth in a new tab. Complete it, then return here.';
  } catch (err) {
    statusEl.textContent = `Error: ${err.message || String(err)}`;
  } finally {
    authBtn.disabled = false;
    refreshStatus();
  }
});

// Live logs via SSE
try {
  const es = new EventSource('/logs');
  es.onmessage = (e) => {
    logEl.textContent += `${e.data}\n`;
    logEl.scrollTop = logEl.scrollHeight;
    if (e.data.includes('Started process pid=')) {
      running = true;
      startBtn.textContent = 'Stop';
    }
    if (e.data.includes('Process exited')) {
      running = false;
      startBtn.textContent = 'Start';
    }
  };
} catch (_) {
  // ignore
}

refreshStatus();
setInterval(refreshStatus, 5000);

