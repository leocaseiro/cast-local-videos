// CastLocalVideos — Electron tray app
//
// Runs the static web server and the Cast companion server in-process,
// then opens the CastLocalVideos sender UI in Google Chrome (where the Cast SDK
// works). Lives in the system tray / menu bar; quitting the tray icon stops
// the servers and exits.

const { app, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const zlib = require('zlib');

const { startCompanionServer } = require('../server.js');
const { startWebServer }       = require('../dev-server.js');

const WEB_PORT       = 8765;
const COMPANION_PORT = 8642;
const SENDER_URL     = `http://localhost:${WEB_PORT}`;

// Single-instance lock — clicking the .app a second time focuses the existing
// tray instance instead of spinning up duplicate servers (port-conflict trap).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let tray;
let webServer;
let companionServer;

app.whenReady().then(start);

app.on('window-all-closed', (e) => { e.preventDefault(); }); // tray-only
app.on('before-quit', shutdown);
app.on('second-instance', () => openInChrome().catch(() => {}));

async function start() {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  try {
    webServer       = startWebServer({ port: WEB_PORT });
    companionServer = startCompanionServer({ port: COMPANION_PORT });
  } catch (err) {
    showFatal('Could not start servers', err);
    return;
  }

  // Surface port-conflict crashes immediately rather than silently 404'ing
  for (const s of [webServer, companionServer]) {
    s.on('error', (err) => showFatal('Server error', err));
  }

  tray = new Tray(loadTrayIcon());
  if (process.platform === 'darwin') tray.setTitle(' CastLocalVideos');
  tray.setToolTip('CastLocalVideos — local video casting');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => tray.popUpContextMenu());

  await openInChrome();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open CastLocalVideos in Chrome', click: () => openInChrome() },
    { label: 'Open in default browser',    click: () => shell.openExternal(SENDER_URL) },
    { type: 'separator' },
    { label: `Web UI:  ${SENDER_URL}`,                       enabled: false },
    { label: `Cast server:  http://localhost:${COMPANION_PORT}`, enabled: false },
    { type: 'separator' },
    { label: 'About CastLocalVideos', click: showAbout },
    { label: 'Quit',              click: () => app.quit(), accelerator: 'CmdOrCtrl+Q' },
  ]);
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: 'CastLocalVideos',
    message: `CastLocalVideos v${app.getVersion()}`,
    detail:
      'Local video player with Chromecast support.\n\n' +
      `Web UI: ${SENDER_URL}\n` +
      `Cast server: http://localhost:${COMPANION_PORT}\n\n` +
      'Keep this app running while casting. The cast feature opens the UI\n' +
      'in Google Chrome — Safari and Firefox cannot cast.',
    buttons: ['OK'],
  });
}

function showFatal(title, err) {
  dialog.showErrorBox(`CastLocalVideos — ${title}`, String(err && err.message || err));
  app.quit();
}

function shutdown() {
  try { webServer       && webServer.close();       } catch {}
  try { companionServer && companionServer.close(); } catch {}
}

// ─── Open the sender UI in Chrome ──────────────────────────────────────────
//
// The Cast SDK only works in Chrome (and Chromium-based browsers with the
// extension), so we deliberately bypass the OS default browser. Falls back
// to shell.openExternal() if Chrome isn't installed.

async function openInChrome() {
  if (await launchChrome(SENDER_URL)) return true;
  shell.openExternal(SENDER_URL);
  return false;
}

function launchChrome(url) {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      // `open -a` uses Launch Services; works wherever Chrome is installed.
      const child = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit',  (code) => resolve(code === 0));
      return;
    }

    if (process.platform === 'win32') {
      const candidates = [
        process.env['LOCALAPPDATA']      && path.join(process.env['LOCALAPPDATA'],      'Google\\Chrome\\Application\\chrome.exe'),
        process.env['ProgramFiles']      && path.join(process.env['ProgramFiles'],      'Google\\Chrome\\Application\\chrome.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'),
      ].filter(Boolean);
      const exe = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      if (!exe) return resolve(false);
      detachSpawn(exe, [url]);
      return resolve(true);
    }

    // Linux: try common chrome/chromium binaries
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      if (commandExists(cmd)) {
        detachSpawn(cmd, [url]);
        return resolve(true);
      }
    }
    resolve(false);
  });
}

function detachSpawn(cmd, args) {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ─── Tray icon ─────────────────────────────────────────────────────────────
//
// Prefer a real PNG at electron/icon.png; otherwise generate a minimal
// monochrome play triangle so the app has *something* in the menu bar without
// shipping a binary asset.

function loadTrayIcon() {
  const iconPath = path.join(__dirname, 'iconTemplate.png');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') img.setTemplateImage(true);
    return img;
  }

  const buf = generatePlayIconPNG(22);
  const img = nativeImage.createFromBuffer(buf);
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

// Minimal RGBA PNG encoder. Generates a black play-triangle on a transparent
// background. macOS treats this as a template image (auto-tinted by the OS).
function generatePlayIconPNG(size) {
  const px = Buffer.alloc(size * size * 4);
  const padX = Math.round(size * 0.27);
  const padY = Math.round(size * 0.18);
  const ax = padX,           ay = padY;
  const bx = padX,           by = size - padY;
  const cx = size - padX,    cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pointInTriangle(x + 0.5, y + 0.5, ax, ay, bx, by, cx, cy)) {
        const i = (y * size + x) * 4;
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255;
      }
    }
  }

  // Add filter byte (0 = none) at the start of each scanline
  const stride = size * 4;
  const filtered = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    px.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(filtered)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s = (px - cx) * (ay - cy) - (ax - cx) * (py - cy);
  const t = (px - ax) * (by - ay) - (bx - ax) * (py - ay);
  if ((s < 0) !== (t < 0) && s !== 0 && t !== 0) return false;
  const d = (px - bx) * (cy - by) - (cx - bx) * (py - by);
  return d === 0 || (d < 0) === (s + t <= 0);
}
