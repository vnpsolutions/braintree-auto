/* eslint-disable no-console */
const path = require('path');
const { app, BrowserWindow } = require('electron');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  win.on('closed', () => { win = null; });
  // Load the local UI server
  win.loadURL('http://localhost:3000');
}

function startServer() {
  // Ensure data dir is writable (userData)
  process.env.APP_DATA_DIR = app.getPath('userData');
  // Start the express UI server within the same process
  // eslint-disable-next-line global-require, import/no-dynamic-require
  require(path.join(__dirname, 'runner.js'));
}

app.whenReady().then(() => {
  startServer();
  // Give the server a brief moment to bind, then open window
  setTimeout(createWindow, 500);
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  // Keep app running only on non-mac; mac typically stays resident
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (win === null) createWindow();
});


