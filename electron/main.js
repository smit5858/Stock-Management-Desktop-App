'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const { resolvePaths, ensureDataDirs, assertWritable } = require('./paths');
const logger = require('./logger');
const settingsFile = require('./settingsFile');
const dbm = require('./db');
const { registerIpc } = require('./ipc');

const DEV_URL = app.isPackaged ? null : process.env.VITE_DEV_SERVER_URL || null;
const INDEX_HTML = path.join(__dirname, '..', 'dist', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;

const paths = resolvePaths({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  env: process.env,
  devRoot: path.resolve(__dirname, '..'),
});

let mainWindow = null;
let shuttingDown = false;
let ready = Promise.resolve();

function isTrustedUrl(url) {
  if (typeof url !== 'string') return false;
  return DEV_URL ? url.startsWith(DEV_URL) : url.startsWith(INDEX_URL);
}

/** Everything (DB, logs, Electron's own profile) must live on the USB, never in AppData. */
function prepareDataFolder() {
  try {
    ensureDataDirs(paths);
    assertWritable(paths.dataDir);
  } catch (err) {
    dialog.showErrorBox(
      'StockApp cannot start',
      `The data folder cannot be written:\n${paths.dataDir}\n\n` +
        'If this is a USB drive, check that it is plugged in, not write-protected and not full.\n\n' +
        err.message,
    );
    return false;
  }
  logger.init(paths.logsDir);
  app.setPath('userData', paths.electronDir);
  app.setPath('sessionData', paths.electronDir);
  app.setPath('crashDumps', path.join(paths.electronDir, 'crashes'));
  app.setAppLogsPath(path.join(paths.electronDir, 'logs'));
  return true;
}

/** No internet, ever: only the app's own files (and the Vite dev server in dev). */
function blockNetwork() {
  const devWs = DEV_URL ? DEV_URL.replace(/^http/, 'ws') : null;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;
    const allowed =
      /^(file|data|blob|devtools):/.test(url) ||
      (DEV_URL && (url.startsWith(DEV_URL) || url.startsWith(devWs)));
    if (!allowed) logger.warn('Blocked network request', url);
    callback({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
}

function saveWindowPrefs(win) {
  try {
    const prefs = settingsFile.read(paths.settingsFile);
    const { width, height } = win.getNormalBounds();
    prefs.window = { width, height, maximized: win.isMaximized() };
    settingsFile.write(paths.settingsFile, prefs);
  } catch (err) {
    logger.warn('Could not save window preferences', err);
  }
}

function createWindow() {
  const prefs = settingsFile.read(paths.settingsFile);
  const win = new BrowserWindow({
    width: prefs.window.width,
    height: prefs.window.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'StockApp',
    backgroundColor: '#f8fafc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false, // the spellchecker would try to download dictionaries
    },
  });

  if (prefs.window.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });

  win.on('close', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    saveWindowPrefs(win);
    shutdownAndExit();
  });
  // Windows logoff / shutdown: no time for a backup, just close the DB cleanly.
  win.on('session-end', () => dbm.closeNow());

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(INDEX_HTML);
  return win;
}

/** Closing backup, then clean DB close, then exit. The UI shows "closing safely" meanwhile. */
async function shutdownAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down');
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:closing');
    await ready;
    await dbm.shutdown();
  } catch (err) {
    logger.error('Shutdown error', err);
  } finally {
    app.exit(0);
  }
}

function main() {
  if (!prepareDataFolder()) {
    app.exit(1);
    return;
  }

  // Lock lives in userData (= data/.electron), so one copy of the data can only be open once.
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }

  process.on('uncaughtException', (err) => logger.error('Uncaught exception', err));
  process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shutdownAndExit();
  });

  app.on('window-all-closed', () => shutdownAndExit());

  app.whenReady().then(() => {
    logger.info(`StockApp ${app.getVersion()} starting (Electron ${process.versions.electron})`);
    if (app.isPackaged) Menu.setApplicationMenu(null);
    blockNetwork();
    ready = dbm.startup(paths).catch((err) => logger.error('Database startup failed', err));
    registerIpc({ paths, ready, isTrustedUrl, getWindow: () => mainWindow });
    mainWindow = createWindow();
  });
}

main();
