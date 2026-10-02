export const DISPLAY_IDLE_MS = 10000;
export const SAVE_IDLE_MS = 60000;

export function createIdleScheduler({ refresh, save, setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, onError = () => {} }) {
  let generation = 0;
  let displayTimer;
  let saveTimer;
  let disposed = false;
  let lastActivity = now();

  function activity() {
    if (disposed) return;
    lastActivity = now();
    const token = ++generation;
    clearTimer(displayTimer);
    clearTimer(saveTimer);
    const current = () => !disposed && token === generation;
    displayTimer = setTimer(() => {
      if (current()) Promise.resolve().then(() => refresh({ canApply: current })).catch(onError);
    }, DISPLAY_IDLE_MS);
    saveTimer = setTimer(() => {
      if (current()) Promise.resolve().then(() => save({ canSave: current })).catch(onError);
    }, SAVE_IDLE_MS);
  }

  function dispose() {
    disposed = true;
    generation += 1;
    clearTimer(displayTimer);
    clearTimer(saveTimer);
  }
  function refreshIfIdle() {
    if (disposed || now() - lastActivity < DISPLAY_IDLE_MS) return;
    const token = generation;
    const current = () => !disposed && token === generation;
    Promise.resolve().then(() => refresh({ canApply: current })).catch(onError);
  }
  function captureWindow() {
    const token = generation;
    return () => !disposed && token === generation;
  }
  function idleSeconds() {
    return Math.max(0, Math.floor((now() - lastActivity) / 1000));
  }
  return { activity, dispose, refreshIfIdle, captureWindow, idleSeconds };
}
