import { STATE_KEY, advanceActivity, localDate, recordContribution, validateState } from './activity.mjs';
import { DEFAULT_CONTRIBUTION_IDLE_MINUTES, contributionIdleMs } from './contribution.mjs';

// Count each editing session once; failed writes retry the same state.
export function createTracker({ readData, writeData, now = () => new Date(), onChange = () => {} }) {
  let state = null;
  let saved = null;
  let loaded = false;
  let replaceRoot = false;
  let tail = Promise.resolve();

  function run(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }

  function snapshot() {
    return { state: state && structuredClone(state), today: localDate(now()),
      savedContributions: saved?.latestContributions ?? null,
      savedContributionIdleMinutes: saved ? saved.contributionIdleMinutes ?? DEFAULT_CONTRIBUTION_IDLE_MINUTES : null, loaded };
  }

  function publish() { onChange(snapshot()); }

  async function load() {
    if (loaded) return;
    const data = await readData();
    saved = validateState(data[STATE_KEY]);
    state = advanceActivity(saved ?? undefined, localDate(now())).state;
    if (state.pendingContribution && now().getTime() - state.pendingContribution.lastChangedAt >= contributionIdleMs(state.contributionIdleMinutes)) {
      delete state.pendingContribution;
    }
    replaceRoot = Object.keys(data).some(key => key !== STATE_KEY);
    loaded = true;
    publish();
  }

  async function persist() {
    if (!replaceRoot && JSON.stringify(saved) === JSON.stringify(state)) return { ...snapshot(), written: false };
    const pending = structuredClone(state);
    await writeData(STATE_KEY, pending);
    saved = pending;
    replaceRoot = false;
    publish();
    return { ...snapshot(), written: true };
  }

  function presaveSession(session) {
    if (state.pendingContribution?.id !== session.id) {
      state = recordContribution(state, session.date, localDate(now()));
    }
    // Keep the first recorded date when an editing session crosses midnight.
    state = { ...state, pendingContribution: { ...session, date: state.pendingContribution?.id === session.id
      ? state.pendingContribution.date : session.date } };
    publish();
  }

  return {
    snapshot,
    load: () => run(async () => { await load(); return snapshot(); }),
    save: () => run(async () => { await load(); return persist(); }),
    setContributionIdleMinutes: minutes => run(async () => {
      contributionIdleMs(minutes);
      await load();
      if (state.contributionIdleMinutes === minutes) return { ...snapshot(), written: false };
      state = { ...state, contributionIdleMinutes: minutes };
      publish();
      return persist();
    }),
    presave: session => run(async () => {
      await load();
      presaveSession(session);
      return persist();
    }),
    touch: session => run(async () => {
      await load();
      if (state.pendingContribution?.id !== session.id) return { ...snapshot(), written: false };
      state = { ...state, pendingContribution: { ...state.pendingContribution, lastChangedAt: session.lastChangedAt } };
      publish();
      return persist();
    }),
    confirm: session => run(async () => {
      await load();
      presaveSession(session);
      delete state.pendingContribution;
      publish();
      return persist();
    }),
    rollover: () => run(async () => {
      await load();
      state = advanceActivity(state, localDate(now())).state;
      publish();
      return persist();
    }),
  };
}
