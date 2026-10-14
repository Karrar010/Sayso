// Runs on the audio thread. The AudioContext is created at 16 kHz, so Chromium has
// already resampled the mic; this converts Float32 frames to 16-bit PCM (Deepgram's
// linear16) and posts 50 ms chunks with their loudness for the waveform.
const CHUNK = 800; // 50 ms at 16 kHz

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(CHUNK);
    this.n = 0;
    this.sumSquares = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;
      if (this.n === CHUNK) this.flush();
    }
    return true;
  }

  flush() {
    if (!this.n) return;
    const pcm = this.buf.slice(0, this.n);
    const rms = Math.sqrt(this.sumSquares / this.n);
    this.port.postMessage({ type: 'chunk', pcm: pcm.buffer, rms }, [pcm.buffer]);
    this.n = 0;
    this.sumSquares = 0;
  }
}

registerProcessor('recorder', Recorder);
