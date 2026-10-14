import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sayso', {
  onCommand: (cb: (cmd: unknown) => void) => ipcRenderer.on('cmd', (_e, cmd) => cb(cmd)),
  audio: (pcm: ArrayBuffer) => ipcRenderer.send('audio', pcm),
  audioEnd: () => ipcRenderer.send('audio-end'),
  micError: (message: string) => ipcRenderer.send('mic-error', message),
});
