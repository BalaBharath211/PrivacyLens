export function createRefreshCoalescer(refresh) {
  let inFlight = null;
  let refreshPending = false;

  return function requestRefresh() {
    if (inFlight) {
      refreshPending = true;
      return inFlight;
    }

    inFlight = (async () => {
      do {
        refreshPending = false;
        await refresh();
      } while (refreshPending);
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };
}