const { app, BrowserWindow, ipcMain, dialog, Notification, Menu, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { resolveAppPath } = require('./protocol-path.cjs');

const MIME_TYPES = {
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.html': 'text/html',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain',
  '.woff2':'font/woff2',
};

// Register custom protocol to allow standard features like ES modules inside Web Workers
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    }
  }
]);

// Suppress harmless GPU disk cache errors on Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Keep a global reference to prevent garbage collection
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
    show: true,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== 'app://root/src/renderer/index.html') event.preventDefault();
  });
  mainWindow.loadURL('app://root/src/renderer/index.html');

  // Open DevTools only in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Build application menu
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Save Transcript',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu-save')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About VoiceScribe',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About VoiceScribe',
              message: 'VoiceScribe v1.0.0',
              detail: 'Professional offline Speech-to-Text for Windows.\nPowered by OpenAI Whisper & Transformers.js.\n\nSupports English and Bengali.',
            });
          }
        },
        {
          label: 'Model Cache Info',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info', title: 'Model Cache Info', message: 'Models are stored in the browser-managed cache.',
              detail: 'The transformers-cache belongs to this app profile. Use Clear cache in the sidebar to remove downloaded models. Internet is required to download them again.',
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// IPC Handlers
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('save-file', async (event, { text, suggestedName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Transcript',
    defaultPath: suggestedName || 'transcript.txt',
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePath) {
    try {
      fs.writeFileSync(result.filePath, text, 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, canceled: true };
});

ipcMain.handle('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

// App lifecycle
app.whenReady().then(() => {
  // Set up handler for the custom protocol — serves files with correct MIME types (needed for ES modules & WASM)
  const logFilePath = path.join(app.getPath('userData'), 'main_debug.log');
  fs.writeFileSync(logFilePath, '--- Main Process Log Started ---\n', 'utf-8');
  function debugLog(msg) {
    try {
      fs.appendFileSync(logFilePath, msg + '\n', 'utf-8');
    } catch(e) {}
  }

  protocol.handle('app', async (request) => {
    try {
      debugLog(`[Protocol] Request URL: ${request.url}`);
      const absolutePath = resolveAppPath(app.getAppPath(), request.url);
      const contentType = MIME_TYPES[path.extname(absolutePath).toLowerCase()];
      if (!contentType) return new Response('Unsupported asset', { status: 404 });
      const content = await fs.promises.readFile(absolutePath);
      return new Response(content, { status: 200, headers: {
        'Content-Type': contentType,
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      } });
    } catch (err) {
      debugLog(`[Protocol Error] ${err.stack || err.message || err}`);
      console.error('Failed to handle app protocol request:', err);
      return new Response('File not found', { status: 404 });
    }
  });

  createWindow();
  createMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
