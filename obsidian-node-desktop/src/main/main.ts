/**
 * Electron main process: window, security policy and IPC wiring. All behaviour lives in
 * src/core (framework independent); this file only connects it to Electron.
 */
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, type AppContext } from '../core/app-context.js';
import { createHandlers, dispatch, wireEvents, type Handlers } from '../core/handlers.js';
import { CHANNELS } from '../shared/contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEME = 'obsidian-app';
const ORIGIN = `${SCHEME}://app`;
const WEB_ROOT = resolve(here, '..', 'web');
const REPOSITORY = 'https://github.com/EmoluxLabs/Obsidian-Node-Exe';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let ctx: AppContext | undefined;
let handlers: Handlers | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;

function readTemplateSha(): string {
  try {
    return readFileSync(join(WEB_ROOT, 'TEMPLATE.sha256'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function unpacked(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

function isAppUrl(url: string): boolean {
  return url.startsWith(`${ORIGIN}/`) || url === ORIGIN;
}

function trustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return isAppUrl(url) && event.sender === mainWindow?.webContents;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0D0E12',
    title: 'Obsidian Node',
    show: false,
    // The template draws its own 40 px title bar; the system draws only the window buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0A0B0E', symbolColor: '#8C92A3', height: 40 },
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const web = mainWindow.webContents;
  web.setWindowOpenHandler(() => ({ action: 'deny' }));
  web.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  web.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('close', (event) => {
    if (quitting || !ctx?.supervisor.isActive()) return;
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      buttons: ['Stop node and quit', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Obsidian Node',
      message: 'The node is running.',
      detail: 'The node belongs to this application. Quitting stops it first, through its normal shutdown, so its database is closed cleanly.',
    });
    if (choice !== 0) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(`${ORIGIN}/index.html`);
}

function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  // The renderer has no network access of its own: only the app's own scheme may load.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !(details.url.startsWith(`${ORIGIN}/`) || details.url.startsWith('devtools://') || details.url.startsWith('data:')) });
  });
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (decoded.includes('\0')) return new Response('Bad request', { status: 400 });
    const relative = normalize(decoded).replace(/^[/\\]+/, '');
    const target = resolve(WEB_ROOT, relative || 'index.html');
    if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(target).href);
  });
}

function registerIpc(): void {
  for (const channel of Object.values(CHANNELS)) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!trustedSender(event) || !handlers) {
        return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'That request did not come from the application window.' } };
      }
      return dispatch(handlers, channel, payload);
    });
  }
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    // A second copy would fight the first over the node's data directory.
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  await app.whenReady();
  lockDownSession();

  ctx = createContext({
    appName: 'Obsidian Node',
    appVersion: app.getVersion(),
    userDataDir: app.getPath('userData'),
    hostScript: unpacked(join(here, 'node-host.js')),
    execPath: process.execPath,
    templateSha256: readTemplateSha(),
    repository: REPOSITORY,
    versions: { electron: process.versions.electron ?? '', chromium: process.versions.chrome ?? '', node: process.versions.node, platform: process.platform, arch: process.arch },
  });
  handlers = createHandlers(ctx, {
    openExternal: (url) => shell.openExternal(url),
    async saveText(suggestedName, text) {
      const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: suggestedName, filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (result.canceled || !result.filePath) return { saved: false };
      writeFileSync(result.filePath, text, { mode: 0o600 });
      return { saved: true, path: result.filePath };
    },
  });
  wireEvents(ctx, (event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, data);
  });
  registerIpc();
  await createWindow();

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !ctx) return;
    // The node belongs to this app: it is stopped (through its own shutdown path) before the app exits.
    event.preventDefault();
    quitting = true;
    void ctx.dispose().finally(() => app.exit(0));
  });
}

void main().catch((error) => {
  dialog.showErrorBox('Obsidian Node could not start', (error as Error).message);
  app.exit(1);
});
