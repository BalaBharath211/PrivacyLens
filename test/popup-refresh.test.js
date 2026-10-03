import assert from 'node:assert/strict';
import test from 'node:test';
import { createPopupRefreshNotifier } from '../background/popup-refresh.js';
import { createRefreshCoalescer } from '../popup/refresh-coalescer.js';

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, time: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.time <= end)
          .sort((left, right) => left[1].time - right[1].time)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.time;
        timer.callback();
      }
      now = end;
    }
  };
}

test('background notification bursts coalesce to one trailing-edge message per 300ms window', () => {
  const timers = createFakeTimers();
  const notifications = [];
  const notifier = createPopupRefreshNotifier({
    sendMessage: (message) => notifications.push(message),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout
  });

  notifier.notify();
  timers.tick(100);
  notifier.notify();
  timers.tick(150);
  notifier.notify();
  timers.tick(49);
  assert.equal(notifications.length, 0);

  timers.tick(1);
  assert.deepEqual(notifications, [{ action: 'requestRecorded' }]);

  notifier.notify();
  timers.tick(300);
  assert.equal(notifications.length, 2);
  notifier.dispose();
});

test('popup coalesces notifications during a refresh into one follow-up refresh', async () => {
  let releaseFirstRefresh;
  let refreshCount = 0;
  const requestRefresh = createRefreshCoalescer(async () => {
    refreshCount += 1;
    if (refreshCount === 1) {
      await new Promise((resolve) => { releaseFirstRefresh = resolve; });
    }
  });

  const activeRefresh = requestRefresh();
  await Promise.resolve();
  for (let index = 0; index < 30; index += 1) requestRefresh();
  assert.equal(refreshCount, 1);

  releaseFirstRefresh();
  await activeRefresh;
  assert.equal(refreshCount, 2);
});