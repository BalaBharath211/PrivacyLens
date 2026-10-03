export function createPopupRefreshNotifier({
  sendMessage,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = 300
}) {
  let timer = null;
  let pending = false;
  let disposed = false;

  function flush() {
    timer = null;
    if (disposed || !pending) return;

    pending = false;
    Promise.resolve(sendMessage({ action: 'requestRecorded' })).catch(() => {});
  }

  function notify() {
    if (disposed) return;
    pending = true;
    if (timer === null) timer = setTimer(flush, intervalMs);
  }

  function dispose() {
    disposed = true;
    pending = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return { notify, dispose };
}