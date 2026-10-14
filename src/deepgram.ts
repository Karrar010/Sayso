import WebSocket from 'ws';

// One Deepgram live-transcription socket per dictation. The socket opens the moment
// the hotkey goes down; audio captured before it is open is queued, so the first
// syllable is never lost.
export class DeepgramStream {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private finals: string[] = [];
  private error: Error | null = null;
  private opened: Promise<void>;
  private onFinalize: (() => void) | null = null;

  constructor(apiKey: string, language: string) {
    const params = new URLSearchParams({
      model: 'nova-3',
      language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      smart_format: 'true',
      punctuate: 'true',
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => {
        for (const chunk of this.queue) this.ws.send(chunk);
        this.queue = [];
        resolve();
      });
      this.ws.once('unexpected-response', (_req, res) => {
        const auth = res.statusCode === 401 || res.statusCode === 403;
        reject((this.error = new Error(auth ? 'Deepgram rejected the API key' : `Deepgram HTTP ${res.statusCode}`)));
        this.ws.terminate();
      });
      // `on`, not `once`: terminate() during the handshake emits a second error.
      this.ws.on('error', (err) => reject((this.error ??= err)));
    });
    this.opened.catch(() => {}); // surfaced by finish()

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== 'Results') return;
      const text: string = msg.channel?.alternatives?.[0]?.transcript ?? '';
      if (msg.is_final && text.trim()) this.finals.push(text.trim());
      if (msg.from_finalize) this.onFinalize?.();
    });
    this.ws.on('close', (code, reason) => {
      if (code !== 1000 && code !== 1005) this.error ??= new Error(`Deepgram closed (${code}) ${reason}`.trim());
    });
  }

  send(pcm: Buffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(pcm);
  }

  /** Flush Deepgram's buffer and return the full transcript. */
  async finish(): Promise<string> {
    await Promise.race([this.opened, delay(5000).then(() => Promise.reject(new Error('Could not reach Deepgram')))]);

    if (this.ws.readyState === WebSocket.OPEN) {
      const finalized = new Promise<boolean>((r) => (this.onFinalize = () => r(true)));
      this.ws.send(JSON.stringify({ type: 'Finalize' }));
      // from_finalize is "typical but not guaranteed" (e.g. near-silent audio), so fall
      // back to CloseStream, which also flushes everything before the socket closes.
      if (!(await Promise.race([finalized, delay(1500).then(() => false)])) && this.ws.readyState === WebSocket.OPEN) {
        const closed = new Promise<void>((r) => this.ws.once('close', () => r()));
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        await Promise.race([closed, delay(3000)]);
      }
    }
    this.ws.close();
    // A late socket error after we already have words is not worth losing the words over.
    if (this.error && this.finals.length === 0) throw this.error;
    return this.finals.join(' ');
  }

  abort() {
    this.ws.terminate();
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
