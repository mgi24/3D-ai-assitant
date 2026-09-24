const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const logDir = path.join(root, 'logs');
const logPath = path.join(logDir, 'desktop.log');
fs.mkdirSync(logDir, { recursive: true });

let sessionToken;
let serverProcess;
let mainWindow;
let poseWindow;
let quitting = false;
let logFd;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (logFd !== undefined) fs.writeSync(logFd, line);
  } catch { }
}

function getPort() {
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) {
    const portLine = fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
      .find(line => /^\s*PORT\s*=/i.test(line));
    const value = portLine?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    if (value && Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) < 65536) {
      return Number(value);
    }
  }
  return 4317;
}

const port = getPort();
const baseUrl = `http://127.0.0.1:${port}`;

async function isServerReady() {
  try {
    const response = await fetch(`${baseUrl}/api/desktop-ready`, {
      headers: { 'X-AICHAT-Desktop-Token': sessionToken },
      signal: AbortSignal.timeout(900)
    });
    const status = await response.json();
    return response.ok && status.desktopUiEnabled === true;
  } catch {
    return false;
  }
}

function startBackend() {
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const server = path.join(root, 'server.py');
  if (!fs.existsSync(python)) throw new Error(`Python virtual environment not found: ${python}`);
  if (!fs.existsSync(server)) throw new Error(`Backend entry point not found: ${server}`);

  log(`Starting local backend on 127.0.0.1:${port}.`);
  serverProcess = spawn(python, [server], {
    cwd: root,
    env: { ...process.env, PORT: String(port), AICHAT_DESKTOP_TOKEN: sessionToken },
    windowsHide: true,
    stdio: ['ignore', logFd, logFd]
  });
  serverProcess.once('error', error => log(`Backend process error: ${error.message}`));
  serverProcess.once('exit', (code, signal) => {
    log(`Backend exited (code=${code}, signal=${signal}).`);
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('AICHAT backend berhenti', 'Periksa logs/desktop.log untuk detailnya.');
      app.quit();
    }
  });
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error('Backend berhenti saat mulai. Periksa logs/desktop.log.');
    }
    if (await isServerReady()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Backend tidak siap di ${baseUrl}. Periksa logs/desktop.log.`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'AICHAT Desktop Avatar',
    width: 440,
    height: 700,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, 'desktop-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let microphoneGranted = false;
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, origin, details) => {
    return webContents === mainWindow?.webContents
      && origin === baseUrl
      && permission === 'media'
      && details.mediaType === 'audio'
      && microphoneGranted;
  });
  mainWindow.webContents.session.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
    const mediaTypes = details.mediaTypes || [];
    const trustedRequest = webContents === mainWindow?.webContents
      && new URL(details.requestingUrl || webContents.getURL()).origin === baseUrl;
    if (!trustedRequest || permission !== 'media' || !mediaTypes.includes('audio') || mediaTypes.includes('video')) {
      callback(false);
      return;
    }
    if (microphoneGranted) {
      callback(true);
      return;
    }
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Izin mikrofon AICHAT',
      message: 'Izinkan AICHAT memakai mikrofon saat Anda memulai percakapan suara?',
      buttons: ['Izinkan', 'Jangan izinkan'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    microphoneGranted = choice.response === 0;
    callback(microphoneGranted);
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== baseUrl) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`Window load failed (${code}): ${description} — ${url}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.isDestroyed()) return;
    const current = new URL(mainWindow.webContents.getURL());
    if (current.origin === baseUrl && current.pathname.startsWith('/app')) {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'floating');
      log('Desktop avatar window is visible.');
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  mainWindow.loadURL(baseUrl).catch(error => {
    log(`Could not load desktop bootstrap: ${error.message}`);
    dialog.showErrorBox('AICHAT gagal dibuka', 'Periksa logs/desktop.log untuk detailnya.');
    app.quit();
  });
}

function createPoseWindow() {
  if (poseWindow && !poseWindow.isDestroyed()) {
    poseWindow.show();
    poseWindow.focus();
    return;
  }
  poseWindow = new BrowserWindow({
    title: 'AICHAT Pose Browser',
    width: 1080,
    height: 820,
    minWidth: 840,
    minHeight: 620,
    parent: mainWindow || undefined,
    backgroundColor: '#f7faf4',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, 'desktop-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      devTools: false
    }
  });
  poseWindow.setMenu(null);
  poseWindow.on('closed', () => { poseWindow = null; });
  poseWindow.webContents.on('did-finish-load', () => {
    if (!poseWindow || poseWindow.isDestroyed()) return;
    const current = new URL(poseWindow.webContents.getURL());
    if (current.origin === baseUrl && current.pathname.startsWith('/app')) {
      poseWindow.setTitle('AICHAT Pose Browser');
      poseWindow.show();
      poseWindow.focus();
      log('Pose Browser window is visible.');
    }
  });
  poseWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`Pose Browser load failed (${code}): ${description} — ${url}`);
  });
  poseWindow.loadURL(`${baseUrl}/?poseBrowser=1`).catch(error => {
    log(`Could not load Pose Browser: ${error.message}`);
    poseWindow?.close();
  });
}

ipcMain.handle('desktop:get-session-token', () => sessionToken);
ipcMain.on('desktop:close', () => mainWindow?.close());
ipcMain.on('desktop:open-pose-browser', () => createPoseWindow());
ipcMain.on('desktop:close-pose-browser', () => poseWindow?.close());

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform !== 'win32') throw new Error('AICHAT Desktop hanya tersedia di Windows.');
    Menu.setApplicationMenu(null);
    logFd = fs.openSync(logPath, 'a');
    sessionToken = crypto.randomBytes(32).toString('base64url');
    startBackend();
    await waitForBackend();
    log('Backend readiness check passed.');
    createWindow();
  }).catch(error => {
    log(`Startup failed: ${error.stack || error.message}`);
    dialog.showErrorBox('AICHAT gagal dimulai', error.message);
    app.quit();
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (serverProcess && serverProcess.exitCode === null) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(serverProcess.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      serverProcess.kill();
    }
  }
  if (logFd !== undefined) {
    try { fs.closeSync(logFd); } catch { }
    logFd = undefined;
  }
});

app.on('window-all-closed', () => app.quit());
