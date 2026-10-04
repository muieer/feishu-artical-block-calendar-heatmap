import { localDate } from './activity.mjs';
import { DEFAULT_CONTRIBUTION_IDLE_MINUTES, contributionIdleMs } from './contribution.mjs';

export const PRESAVE_IDLE_MS = 10000;

export function isDocumentContentChange(event) {
  // Web runtime emits silence changes during model hydration.
  // from is absent from public API docs and SDK 0.0.11 types; preserve other origins.
  return Array.isArray(event?.changes)
    && event.changes.some(change => change?.from !== 'silence'
      && ['insert', 'remove', 'update'].includes(change?.type));
}

export function createIdleScheduler({ presave, confirm, onActivity = () => {}, restored = null,
  contributionIdleMinutes = DEFAULT_CONTRIBUTION_IDLE_MINUTES,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  dateNow = () => new Date(), createId = () => globalThis.crypto.randomUUID(), onError = () => {} }) {
  let timer;
  let idleMs = contributionIdleMs(contributionIdleMinutes);
  let pending = restored ? { ...restored } : null;
  let lastChangedAt = pending?.lastChangedAt ?? null;
  let presaved = Boolean(restored);
  let needsSave = false;
  let disposed = false;

  function notify(callback, session) {
    Promise.resolve().then(() => callback({ ...session })).catch(onError);
  }

  function finishIfIdle() {
    if (disposed || !pending) return false;
    const elapsed = now() - pending.lastChangedAt;
    if (elapsed >= idleMs) {
      const completed = pending;
      pending = null;
      needsSave = false;
      presaved = false;
      clearTimer(timer);
      // Finalize before accepting another edit, even when browser timers were delayed.
      notify(confirm, completed);
      return true;
    }
    if (needsSave && elapsed >= PRESAVE_IDLE_MS) {
      needsSave = false;
      presaved = true;
      notify(presave, pending);
    }
    return false;
  }

  function arm() {
    if (!pending || disposed) return;
    const threshold = needsSave ? PRESAVE_IDLE_MS : idleMs;
    timer = setTimer(() => {
      finishIfIdle();
      arm();
    }, Math.max(0, threshold - (now() - pending.lastChangedAt)));
  }

  function activity(event) {
    if (disposed || !isDocumentContentChange(event)) return false;
    finishIfIdle();
    pending = pending ? { ...pending, lastChangedAt: now(), date: presaved ? pending.date : localDate(dateNow()) }
      : { id: createId(), lastChangedAt: now(), date: localDate(dateNow()) };
    needsSave = true;
    lastChangedAt = pending.lastChangedAt;
    notify(onActivity, pending);
    clearTimer(timer);
    arm();
    return true;
  }

  if (pending) { finishIfIdle(); arm(); }
  return {
    activity,
    finishIfIdle,
    setContributionIdleMinutes(minutes) {
      const nextIdleMs = contributionIdleMs(minutes);
      if (disposed || nextIdleMs === idleMs) return;
      idleMs = nextIdleMs;
      clearTimer(timer);
      finishIfIdle();
      arm();
    },
    hasPending: () => pending !== null,
    lastEditedAt: () => lastChangedAt,
    idleSeconds: () => pending ? Math.max(0, Math.floor((now() - pending.lastChangedAt) / 1000)) : null,
    dispose() { disposed = true; pending = null; clearTimer(timer); },
  };
}
