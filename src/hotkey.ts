// Sayso's Windows hotkeys:
//   Ctrl + Win          hold to talk, release to transcribe + paste
//   Ctrl + Win + Shift  hands-free: press to start, press Ctrl + Win again to stop
//   Esc                 cancel (nothing is pasted)
// Adding Shift while holding Ctrl + Win latches the session into hands-free mode.

export type HotkeyAction = 'start' | 'stop' | 'cancel';

export const Key = {
  Escape: 1,
  Ctrl: 29,
  CtrlRight: 3613,
  Shift: 42,
  ShiftRight: 54,
  Alt: 56,
  AltRight: 3640,
  Meta: 3675,
  MetaRight: 3676,
} as const;

const CTRL = [Key.Ctrl, Key.CtrlRight];
const WIN = [Key.Meta, Key.MetaRight];
const SHIFT = [Key.Shift, Key.ShiftRight];
const MODIFIERS = [...CTRL, ...WIN, ...SHIFT, Key.Alt, Key.AltRight];

export class HotkeyTracker {
  private down = new Set<number>();
  private mode: 'idle' | 'hold' | 'handsfree' = 'idle';
  // After a hands-free start/stop the combo must be fully released before it counts again.
  private needRelease = false;

  constructor(private emit: (action: HotkeyAction) => void) {}

  get recording() {
    return this.mode !== 'idle';
  }

  anyModifierDown() {
    return MODIFIERS.some((k) => this.down.has(k));
  }

  /** Called by the app when a session ends on its own (error, too short, etc.). */
  reset() {
    this.mode = 'idle';
    this.needRelease = this.combo();
  }

  keydown(code: number) {
    if (this.down.has(code)) return; // OS auto-repeat
    this.down.add(code);

    if (code === Key.Escape && this.mode !== 'idle') {
      this.mode = 'idle';
      this.needRelease = this.combo();
      this.emit('cancel');
      return;
    }
    if (!this.combo() || this.needRelease) return;

    const shift = this.has(SHIFT);
    if (this.mode === 'idle') {
      this.mode = shift ? 'handsfree' : 'hold';
      this.needRelease = shift;
      this.emit('start');
    } else if (this.mode === 'hold' && shift) {
      this.mode = 'handsfree'; // latch
      this.needRelease = true;
    } else if (this.mode === 'handsfree') {
      this.mode = 'idle';
      this.needRelease = true;
      this.emit('stop');
    }
  }

  keyup(code: number) {
    this.down.delete(code);
    if (this.combo()) return;
    this.needRelease = false;
    if (this.mode === 'hold') {
      this.mode = 'idle';
      this.emit('stop');
    }
  }

  /** The hook misses key-ups while the screen is locked (Win+L), so forget everything held. */
  clear() {
    this.down.clear();
    this.needRelease = false;
    if (this.mode !== 'idle') {
      this.mode = 'idle';
      this.emit('cancel');
    }
  }

  private has(keys: number[]) {
    return keys.some((k) => this.down.has(k));
  }

  private combo() {
    return this.has(CTRL) && this.has(WIN);
  }
}
