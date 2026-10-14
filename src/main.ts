import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { cleanTranscript, warmUp } from './cleanup';
import { DeepgramStream } from './deepgram';
import { HotkeyTracker } from './hotkey';

// The overlay never gets a click, and Chromium keeps an AudioContext suspended until
// one happens. Without this switch the mic would never start.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---------- config ----------

// Installed app: %APPDATA%\Sayso\.env. From source (npm start): the project's own .env.
const envPath = path.join(app.isPackaged ? app.getPath('userData') : app.getAppPath(), '.env');
const hasEnv = fs.existsSync(envPath);
if (hasEnv) process.loadEnvFile(envPath);

const config = {
  deepgramKey: process.env.DEEPGRAM_API_KEY?.trim() ?? '',
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() ?? '',
  language: process.env.DEEPGRAM_LANGUAGE?.trim() || 'en',
  model: process.env.CLAUDE_MODEL?.trim() || 'claude-haiku-5-5',
  mic: process.env.MIC_NAME?.trim() ?? '',
  micAlwaysOn: process.env.MIC_ALWAYS_ON?.trim().toLowerCase() !== 'false',
};

const logFile = path.join(app.getPath('userData'), 'sayso.log');
function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.message : String(p))).join(' ')}`;
  console.log(line);
  fs.appendFile(logFile, line + '\n', () => {});
}

// ---------- overlay (the floating pill) ----------

const OVERLAY = { width: 320, height: 72, bottomGap: 28 };
let overlay: BrowserWindow;
let hideTimer: NodeJS.Timeout | undefined;

function createOverlay() {
  overlay = new BrowserWindow({
    ...OVERLAY,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false, // never steal focus from the app being typed into
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // keep capturing audio while hidden/occluded
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log('overlay:', e.message);
  });
  overlay.webContents.on('did-finish-load', () =>
    send({ type: 'config', config: { mic: config.mic, alwaysOn: config.micAlwaysOn } }),
  );
  overlay.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
}

function showOverlay() {
  clearTimeout(hideTimer);
  // Bottom-centre of whichever screen the mouse is on, like Glaido's dictation bar.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlay.setBounds({
    x: Math.round(workArea.x + (workArea.width - OVERLAY.width) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY.height - OVERLAY.bottomGap),
    width: OVERLAY.width,
    height: OVERLAY.height,
  });
  overlay.showInactive();
}

function hideOverlay(afterMs = 0) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    send({ type: 'state', state: 'hidden' });
    overlay.hide();
  }, afterMs);
}

type OverlayCommand =
  | { type: 'config'; config: { mic: string; alwaysOn: boolean } }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'state'; state: 'listening' | 'processing' | 'done' | 'hidden' }
  | { type: 'state'; state: 'error'; message: string };

function send(cmd: OverlayCommand) {
  overlay.webContents.send('cmd', cmd);
}

function showError(message: string) {
  log('error:', message);
  send({ type: 'state', state: 'error', message });
  showOverlay();
  hideOverlay(2600);
}

// ---------- dictation session ----------

type Session = { stream: DeepgramStream; startedAt: number; audioBytes: number; peak: number };
let phase: 'idle' | 'recording' | 'processing' = 'idle';
let current: Session | null = null;
let audioEnded: (() => void) | null = null;
let lastText = '';

const hotkeys = new HotkeyTracker((action) => {
  if (action === 'start') startDictation();
  else if (action === 'stop') stopDictation();
  else cancelDictation();
});

function startDictation() {
  if (phase !== 'idle') return hotkeys.reset(); // still pasting the previous one
  if (!config.deepgramKey) {
    hotkeys.reset();
    return showError('Add DEEPGRAM_API_KEY to .env');
  }
  // Windows opens the Start menu when Win is released with no other key pressed in
  // between. Tapping an unused key (F24) while Win is held prevents that, as
  // AutoHotkey's "menu mask key" does.
  uIOhook.keyTap(UiohookKey.F24);

  phase = 'recording';
  current = { stream: new DeepgramStream(config.deepgramKey, config.language), startedAt: Date.now(), audioBytes: 0, peak: 0 };
  if (config.anthropicKey) warmUp(config.anthropicKey, config.model);
  send({ type: 'start' });
  send({ type: 'state', state: 'listening' });
  showOverlay();
}

function cancelDictation() {
  if (phase !== 'recording' || !current) return;
  current.stream.abort();
  current = null;
  phase = 'idle';
  send({ type: 'cancel' });
  hideOverlay();
}

async function stopDictation() {
  if (phase !== 'recording' || !current) return;
  const session = current;
  // A tap shorter than this is almost always an accidental Ctrl+Win.
  if (Date.now() - session.startedAt < 300) {
    current = null;
    session.stream.abort();
    phase = 'idle';
    send({ type: 'cancel' });
    return hideOverlay();
  }

  phase = 'processing';
  send({ type: 'state', state: 'processing' });
  try {
    // Wait for the renderer to flush its last audio frames (they still go to `current`).
    await new Promise<void>((resolve) => {
      audioEnded = resolve;
      send({ type: 'stop' });
      setTimeout(resolve, 1000);
    });
    audioEnded = null;
    current = null;
    // Peak level tells "mic muted / wrong mic" (below about -50 dB) apart from "nothing was said".
    const peakDb = Math.round(20 * Math.log10(Math.max(session.peak, 1) / 32768));
    log(`captured ${(session.audioBytes / 32000).toFixed(1)}s of audio, peak ${peakDb} dBFS`); // 16 kHz * 2 bytes

    const t0 = Date.now();
    const raw = (await session.stream.finish()).trim();
    const t1 = Date.now();
    if (!raw) {
      phase = 'idle';
      return showError('No speech detected');
    }

    let text = raw;
    if (config.anthropicKey) {
      try {
        text = await cleanTranscript(raw, config.anthropicKey, config.model);
      } catch (err) {
        log('cleanup failed, pasting raw transcript:', err);
      }
    }
    log(`stt ${t1 - t0}ms, cleanup ${Date.now() - t1}ms, ${raw.length} -> ${text.length} chars`);
    if (!text) {
      phase = 'idle';
      return showError('No speech detected');
    }

    lastText = text;
    await paste(text);
    send({ type: 'state', state: 'done' });
    hideOverlay(450);
  } catch (err) {
    current = null;
    session.stream.abort();
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    phase = 'idle';
    updateTray();
  }
}

async function paste(text: string) {
  // The text stays on the clipboard on purpose: if no text field had focus,
  // Ctrl+V still recovers it (tray > "Copy last dictation" does too).
  clipboard.writeText(text);
  // If Ctrl/Win/Shift are still physically down, our Ctrl+V would become e.g. Ctrl+Win+V.
  for (let waited = 0; hotkeys.anyModifierDown() && waited < 1500; waited += 20) await delay(20);
  const modifier = process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl;
  uIOhook.keyTap(UiohookKey.V, [modifier]);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- renderer IPC ----------

ipcMain.on('audio', (_e, pcm: ArrayBuffer) => {
  if (!current) return;
  current.audioBytes += pcm.byteLength;
  for (const sample of new Int16Array(pcm)) current.peak = Math.max(current.peak, Math.abs(sample));
  current.stream.send(Buffer.from(pcm));
});
ipcMain.on('audio-end', () => audioEnded?.());
ipcMain.on('mic-error', (_e, message: string) => {
  if (phase !== 'recording') return;
  current?.stream.abort();
  current = null;
  phase = 'idle';
  hotkeys.reset();
  showError(message);
});

// ---------- tray ----------

let tray: Tray;

function trayIcon() {
  // 32x32 BGRA lime dot (Glaido's accent), drawn in code so no asset files are needed.
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      const alpha = Math.max(0, Math.min(1, 12.5 - d));
      const i = (y * size + x) * 4;
      buf[i] = 0x3c; // B
      buf[i + 1] = 0xf2; // G
      buf[i + 2] = 0xc4; // R
      buf[i + 3] = Math.round(alpha * 255);
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function updateTray() {
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Hold Ctrl + Win to dictate', enabled: false },
    { label: 'Ctrl + Win + Shift for hands-free, Esc to cancel', enabled: false },
    { type: 'separator' },
    { label: 'Copy last dictation', enabled: !!lastText, click: () => clipboard.writeText(lastText) },
    { label: 'Open settings folder (.env)', click: () => shell.openPath(path.dirname(envPath)) },
    { label: 'Open log', click: () => shell.openPath(logFile) },
  ];
  if (app.isPackaged) {
    items.push({
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  items.push({ type: 'separator' }, { label: 'Quit Sayso', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- boot ----------

if (!app.requestSingleInstanceLock()) app.quit();
else
  app.whenReady().then(() => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

    createOverlay();
    tray = new Tray(trayIcon());
    tray.setToolTip('Sayso: hold Ctrl + Win to dictate');
    updateTray();

    uIOhook.on('keydown', (e) => hotkeys.keydown(e.keycode));
    uIOhook.on('keyup', (e) => hotkeys.keyup(e.keycode));
    uIOhook.start();
    powerMonitor.on('lock-screen', () => hotkeys.clear());
    powerMonitor.on('suspend', () => hotkeys.clear());

    log(`started; env ${hasEnv ? envPath : 'missing'}; model ${config.model}; language ${config.language}`);
    if (!config.deepgramKey || !config.anthropicKey) {
      new Notification({
        title: 'Sayso needs API keys',
        body: `Put DEEPGRAM_API_KEY and ANTHROPIC_API_KEY in ${envPath}, then restart Sayso.`,
      }).show();
    }
  });

app.on('window-all-closed', () => {}); // tray app: keep running
app.on('will-quit', () => uIOhook.stop());
