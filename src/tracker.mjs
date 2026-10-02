import { STATE_KEY, advanceActivity, localDate, revisionNumber, validateState } from './activity.mjs';

// Observations advance in memory; only save persists the accumulated state.
export function createTracker({ readData, writeData, readRevision, now = () => new Date() }) {
  let state = null;
  let saved = null;
  let loaded = false;
  let tail = Promise.resolve();

  function run(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }

  function snapshot(notice = '', extra = {}) {
    return { state, revision: state?.latestRevision ?? null, today: localDate(now()),
      savedRevision: saved?.latestRevision ?? null, notice, ...extra };
  }

  async function observe(canApply = () => true) {
    const revision = revisionNumber(await readRevision());
    const today = localDate(now());
    if (!loaded) {
      try {
        const data = await readData();
        saved = validateState(data[STATE_KEY]);
        state = saved;
        loaded = true;
      } catch (error) {
        error.observation = { revision, today, savedRevision: null };
        throw error;
      }
    }
    if (!canApply()) return snapshot('', { cancelled: true });
    const result = advanceActivity(state, today, revision);
    state = result.state;
    return snapshot(result.notice);
  }

  return {
    refresh: ({ canApply } = {}) => run(() => observe(canApply)),
    save: ({ canSave = () => true } = {}) => run(async () => {
      // Cancel queued attempts before reading, and recheck after awaited reads.
      if (!canSave()) return snapshot('', { cancelled: true });
      const result = await observe(canSave);
      if (result.cancelled || !canSave()) return snapshot('', { cancelled: true });
      const unchanged = JSON.stringify(saved) === JSON.stringify(state);
      if (!unchanged) {
        const pending = structuredClone(state);
        // Once issued, a write completes even if editing resumes.
        await writeData(STATE_KEY, pending);
        saved = pending;
      }
      return snapshot(result.notice, { written: !unchanged });
    }),
  };
}
