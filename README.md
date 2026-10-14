# Sayso

Personal push-to-talk dictation for Windows:

**Hold `Ctrl + Win` → speak → release → polished text is pasted where your cursor is.**

| Hotkey | What it does |
|---|---|
| `Ctrl + Win` (hold) | Record while held; release to transcribe, clean up and paste |
| `Ctrl + Win + Shift` | Hands-free: press once to start, press `Ctrl + Win` again to stop |
| Add `Shift` while holding | Switches the current recording to hands-free |
| `Esc` | Cancel; nothing is pasted |

A small pill appears at the bottom-centre of the screen with a live blue waveform while you
talk. It pulses while processing and never takes focus from the app you are typing in.

## How it works

```
hotkey down ─► mic (AudioWorklet, 16 kHz PCM, 50 ms chunks) ─► Deepgram Nova-3 WebSocket (streams while you talk)
hotkey up   ─► Finalize ─► transcript ─► Claude Haiku 5.5 cleanup ─► clipboard ─► Ctrl+V into the focused window
```

| File | Role |
|---|---|
| `src/hotkey.ts` | Global hotkey state machine (hold / hands-free / Esc), fed by a low-level keyboard hook (`uiohook-napi`) |
| `src/deepgram.ts` | Streaming WebSocket client. The socket opens on key-down and queues audio until it connects, so your first word isn't lost |
| `src/cleanup.ts` | Claude call that strips fillers and fixes grammar and punctuation. It treats your dictation as text, never as a question to answer |
| `src/main.ts` | Wires everything together: overlay window, tray menu, clipboard and paste |
| `overlay/` | The floating pill: mic capture, waveform and states |

If Claude is unreachable or slow (8 s timeout), the raw Deepgram transcript is pasted instead,
so a dictation is never lost. The pasted text also stays on the clipboard, and the tray menu
has **Copy last dictation**.

## Setup

Requires Node.js 22+. The project folder must have a **short path**, for example
`C:\Users\<you>\Projects\sayso`. Electron fails to start from very deep folders
(`Error loading V8 startup snapshot file`).

```bash
npm install
```

Copy `.env.example` to `.env` and paste your keys:

```
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=...
```

`.env` is in `.gitignore`, so it is never committed.

### Run from source

```bash
npm start
```

### Install as a normal Windows app (recommended)

```bash
npm run dist
```

Run the installer in `release/` (`Sayso Setup 1.0.0.exe`). The installed app reads its keys from
`%APPDATA%\Sayso\.env`: copy your `.env` there. The tray menu has **Open settings folder**.
Then turn on **Start with Windows** in the tray menu.

## Options (`.env`)

| Key | Default | |
|---|---|---|
| `DEEPGRAM_LANGUAGE` | `en` | `en-US`, `en-GB`, … or `multi` if you mix languages |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Model used for cleanup |
| `MIC_NAME` | Windows default mic | Part of a mic's name, e.g. `Logi` for the USB headset or `Realtek` for the built-in array |
| `MIC_ALWAYS_ON` | `true` | Keeps the mic open so recording starts instantly and catches the 300 ms before you press. Audio only leaves your PC while the hotkey is held. Windows shows its mic-in-use icon while Sayso runs. `false` opens the mic per dictation, which adds ~0.3–0.9 s and can clip your first word |

## Troubleshooting

- **Nothing happens on Ctrl + Win.** Check that Sayso's blue dot is in the tray (it may be under the `^` overflow).
- **"Microphone blocked"**: turn on *Settings → Privacy → Microphone → Allow desktop apps to access your microphone*.
- **Text is not pasted into an app running as Administrator.** Windows blocks normal apps from sending keys to elevated ones. Press `Ctrl + V` yourself; the text is already on the clipboard.
- **"No speech detected"**: check the log. `peak` below about -50 dBFS means the wrong or muted mic; set `MIC_NAME`.
- **Logs**: tray → *Open log* (`%APPDATA%\Sayso\sayso.log`). It records audio length, peak level and Deepgram and Claude timings for each dictation. It does not record the text.

## Cost

Deepgram Nova-3 streaming is billed per audio minute. Claude Haiku 5.5 costs $0.10 / $0.50 per
million input/output tokens, which is roughly $0.00005 per dictation. $4.50 lasts for tens of
thousands of dictations.
