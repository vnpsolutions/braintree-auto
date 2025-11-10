const form = document.getElementById('start-form');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  startBtn.disabled = true;
  startBtn.textContent = 'Starting...';
  try {
    const data = new FormData(form);
    const res = await fetch('/start', {
      method: 'POST',
      body: data
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(json.error || 'Failed to start');
    }
    statusEl.textContent = `Started process (pid ${json.pid}). Check the terminal window for logs.`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message || String(err)}`;
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Start';
  }
});


