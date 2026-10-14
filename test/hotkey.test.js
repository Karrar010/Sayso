const test = require('node:test');
const assert = require('node:assert');
const { HotkeyTracker, Key } = require('../dist/hotkey');

function tracker() {
  const events = [];
  const t = new HotkeyTracker((a) => events.push(a));
  const down = (...keys) => keys.forEach((k) => t.keydown(k));
  const up = (...keys) => keys.forEach((k) => t.keyup(k));
  return { t, events, down, up };
}

test('hold Ctrl+Win, release: start then stop', () => {
  const { events, down, up } = tracker();
  down(Key.Ctrl, Key.Meta);
  down(Key.Meta); // auto-repeat is ignored
  assert.deepStrictEqual(events, ['start']);
  up(Key.Meta, Key.Ctrl);
  assert.deepStrictEqual(events, ['start', 'stop']);
});

test('either side and either order works', () => {
  const { events, down, up } = tracker();
  down(Key.MetaRight, Key.CtrlRight);
  up(Key.CtrlRight);
  assert.deepStrictEqual(events, ['start', 'stop']);
});

test('Ctrl alone or Win alone does nothing', () => {
  const { events, down, up } = tracker();
  down(Key.Ctrl); up(Key.Ctrl);
  down(Key.Meta); up(Key.Meta);
  assert.deepStrictEqual(events, []);
});

test('hands-free: Ctrl+Win+Shift starts, release keeps recording, Ctrl+Win stops', () => {
  const { events, down, up } = tracker();
  down(Key.Ctrl, Key.Meta, Key.Shift);
  assert.deepStrictEqual(events, ['start']);
  up(Key.Shift, Key.Meta, Key.Ctrl);
  assert.deepStrictEqual(events, ['start']);
  down(Key.Ctrl, Key.Meta);
  assert.deepStrictEqual(events, ['start', 'stop']);
  up(Key.Meta, Key.Ctrl); // releasing the stop combo must not start or stop again
  down(Key.Ctrl); up(Key.Ctrl);
  assert.deepStrictEqual(events, ['start', 'stop']);
});

test('adding Shift during hold latches hands-free', () => {
  const { events, down, up } = tracker();
  down(Key.Ctrl, Key.Meta, Key.ShiftRight);
  up(Key.ShiftRight, Key.Meta, Key.Ctrl);
  assert.deepStrictEqual(events, ['start']);
  down(Key.Ctrl, Key.Meta, Key.Shift);
  assert.deepStrictEqual(events, ['start', 'stop']);
});

test('Esc cancels and the held combo does not restart', () => {
  const { events, down, up } = tracker();
  down(Key.Ctrl, Key.Meta, Key.Escape);
  up(Key.Escape, Key.Meta, Key.Ctrl);
  assert.deepStrictEqual(events, ['start', 'cancel']);
  down(Key.Escape); // Esc while idle is left alone
  assert.deepStrictEqual(events, ['start', 'cancel']);
});

test('clear() after a lost key-up (Win+L) cancels and forgets stuck keys', () => {
  const { t, events, down, up } = tracker();
  down(Key.Ctrl, Key.Meta);
  t.clear(); // key-ups never arrive
  down(Key.Ctrl); up(Key.Ctrl); // a later plain Ctrl+C must not start dictation
  assert.deepStrictEqual(events, ['start', 'cancel']);
  assert.strictEqual(t.anyModifierDown(), false);
});
