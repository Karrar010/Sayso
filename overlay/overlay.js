// Overlay renderer: owns the microphone (getUserMedia + AudioWorklet) and draws the pill.
//
// Opening a Windows mic takes 300-900 ms, which would clip the first words. So by default
// the mic stays open while Sayso runs and the last 300 ms are kept in memory. Audio only
// leaves this window while the hotkey is down. MIC_ALWAYS_ON=false opens it per dictation.
const BAR_COUNT = 13;
const PREROLL_CHUNKS = 6; // 6 x 50 ms

const wave = document.querySelector('.wave');
const message = document.querySelector('.message');
const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.setProperty('--i', String(i));
  wave.appendChild(bar);
  return bar;
});

let config = { mic: '', alwaysOn: true };
let ctx = null;
let mic = null; // { stream, source, node }
let opening = null;
let recording = false;
let stopping = false;
const preroll = [];

// ---------- microphone ----------

async function micDeviceId(name) {
  if (!name) return undefined;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const match = devices.find((d) => d.kind === 'audioinput' && d.label.toLowerCase().includes(name.toLowerCase()));
  return match ? { exact: match.deviceId } : undefined; // unknown name: use the Windows default mic
}

function openMic() {
  opening ??= (async () => {
    try {
      if (!ctx) {
        ctx = new AudioContext({ sampleRate: 16000 }); // Chromium resamples the mic to 16 kHz
        await ctx.audioWorklet.addModule('recorder-worklet.js');
      }
      if (ctx.state === 'suspended') await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: await micDeviceId(config.mic),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const source = ctx.createMediaStreamSource(stream);
      // No outputs: Chromium still runs the processor, and nothing is played back.
      const node = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = onWorkletMessage;
      source.connect(node);
      // Headset unplugged, driver reset, sleep: reopen on whatever mic is now available.
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        closeMic();
        if (config.alwaysOn) setTimeout(keepMicOpen, 1000);
      });
      mic = { stream, source, node };
    } finally {
      opening = null;
    }
  })();
  return opening;
}

function closeMic() {
  if (!mic) return;
  const { stream, source, node } = mic;
  mic = null;
  node.port.onmessage = null;
  source.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  preroll.length = 0;
}

function keepMicOpen() {
  if (!config.alwaysOn || mic) return;
  openMic().catch((err) => {
    console.error('mic open failed:', err && err.name, err && err.message);
    setTimeout(keepMicOpen, 30000);
  });
}

function onWorkletMessage(e) {
  if (e.data.type === 'chunk') {
    if (recording) {
      window.sayso.audio(e.data.pcm);
      pushLevel(e.data.rms);
    } else if (config.alwaysOn) {
      preroll.push(e.data.pcm);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
    }
  } else if (e.data.type === 'flushed' && stopping) {
    endRecording();
  }
}

// ---------- dictation commands from the main process ----------

async function start() {
  recording = true;
  stopping = false;
  for (const pcm of preroll.splice(0)) window.sayso.audio(pcm);
  try {
    if (!mic) await openMic();
    if (!recording) {
      if (!config.alwaysOn) closeMic(); // released while the mic was opening
      return;
    }
    chime(660, 880);
  } catch (err) {
    console.error('mic start failed:', err && err.name, err && err.message);
    if (!recording) return;
    recording = false;
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    window.sayso.micError(denied ? 'Microphone blocked: check Windows privacy settings' : 'No microphone found');
  }
}

function stop() {
  if (!recording) return window.sayso.audioEnd();
  chime(880, 620);
  if (!mic) return endRecording(); // released before the mic opened
  stopping = true;
  mic.node.port.postMessage('flush'); // worklet sends its last frames, then 'flushed'
}

function endRecording() {
  recording = false;
  stopping = false;
  window.sayso.audioEnd();
  if (!config.alwaysOn) closeMic();
}

function cancel() {
  recording = false;
  stopping = false;
  if (!config.alwaysOn) closeMic();
}

// Short, quiet start/stop tones (Glaido has interaction sounds too).
function chime(from, to) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + 0.07);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}

// ---------- waveform ----------

const levels = new Array(BAR_COUNT).fill(0);
let drawing = false;

function pushLevel(rms) {
  // Speech RMS sits around 0.02-0.2; a log curve makes quiet talking still visibly move.
  const level = Math.max(0, Math.min(1, (Math.log10(rms + 1e-4) + 3.2) / 2.4));
  levels.shift();
  levels.push(level);
}

function draw() {
  if (!drawing) return;
  const mid = (BAR_COUNT - 1) / 2;
  bars.forEach((bar, i) => {
    // Newest level in the centre, older ones fanning out to both edges.
    const age = Math.abs(i - mid);
    const level = levels[BAR_COUNT - 1 - Math.round(age)] * (1 - age / (mid + 2));
    bar.style.height = `${4 + level * 18}px`;
  });
  requestAnimationFrame(draw);
}

function setState(state, text = '') {
  document.body.dataset.state = state;
  message.textContent = text;
  drawing = state === 'listening';
  if (drawing) {
    levels.fill(0);
    requestAnimationFrame(draw);
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  // A newly plugged-in headset becomes the Windows default; follow it when idle.
  if (!config.alwaysOn || recording || !mic) return;
  closeMic();
  keepMicOpen();
});

window.sayso.onCommand((cmd) => {
  switch (cmd.type) {
    case 'config':
      config = cmd.config;
      return keepMicOpen();
    case 'start': return start();
    case 'stop': return stop();
    case 'cancel': return cancel();
    case 'state': return setState(cmd.state, cmd.message);
  }
});
