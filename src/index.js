import { calendarDates, colorLevel, colorThresholds, dayActivity, addDays, localDate } from './activity.mjs';
import { createTracker } from './tracker.mjs';
import { createIdleScheduler } from './idle.mjs';
import { connectFeishu } from './feishu';
import './index.css';

const grid = document.getElementById('heatmap');
const months = document.getElementById('months');
const status = document.getElementById('status');
const recent = document.getElementById('recent-days');
const idleSeconds = document.getElementById('idle-seconds');
const SAVE_RETRY_MS = 10000;
let host;
let tracker;
let idle;
let retryTimer;
let dayCheckInFlight = false;
let disposed = false;

function describe(day) {
  if (day.status === 'pending') return `${day.delta} · pending（未结算）`;
  if (day.status === 'no-data') return '无数据';
  if (day.status === 'future') return '未来日期';
  return `${day.delta} · 已结算`;
}

function render(result = { state: null, today: localDate(), savedContributions: null }) {
  const { state, today } = result;
  const dates = calendarDates(state?.startedOn ?? today, today);
  const thresholds = colorThresholds(state?.history || {});
  grid.replaceChildren();
  months.replaceChildren();
  let previousMonth = '';
  dates.forEach((date, index) => {
    if (index % 7 === 0) {
      const month = date.slice(0, 7);
      const label = document.createElement('span');
      label.textContent = month !== previousMonth ? `${Number(month.slice(5))}月` : '';
      months.append(label);
      previousMonth = month;
    }
    const day = dayActivity(state, date, today);
    const level = day.status === 'settled' || day.status === 'pending' ? colorLevel(day.delta, thresholds) : 0;
    const cell = document.createElement('span');
    cell.className = `cell level-${level} ${day.status}`;
    cell.dataset.date = date;
    cell.dataset.status = day.status;
    cell.title = `${date}：贡献次数 ${describe(day)}`;
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  });
  grid.setAttribute('aria-label', `${dates[0]} 至 ${dates.at(-1)} 的每日编辑活跃度；绿色表示贡献次数，今天随贡献次数更新颜色，蓝色轮廓表示当天未结算。`);
  document.getElementById('date-range').textContent = `${today} · 本地日期`;
  document.getElementById('latest-contributions').textContent = state?.latestContributions ?? '—';
  document.getElementById('saved-contributions').textContent = result.savedContributions ?? '—';
  document.getElementById('baseline-contributions').textContent = state?.baselineContributions ?? '—';
  document.getElementById('live-delta').textContent = state?.currentDate === today ? state.latestContributions - state.baselineContributions : '—';
  document.getElementById('current-date').textContent = state?.currentDate ?? '尚未开始';
  document.getElementById('timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('started-on').textContent = state?.startedOn ?? '—';
  recent.replaceChildren();
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = addDays(today, offset);
    const day = dayActivity(state, date, today);
    const row = document.createElement('tr');
    for (const value of [date, day.delta ?? '—', date === today ? 'pending' : day.status === 'settled' ? '已结算' : '无数据']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    recent.append(row);
  }
}

function showError(error) {
  if (disposed) return;
  status.textContent = error.message || '读取或保存失败。';
  status.classList.add('error');
}

function scheduleRetry() {
  if (disposed || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    persist(() => tracker.save());
  }, SAVE_RETRY_MS);
}

async function persist(operation, quiet = false) {
  if (disposed) return;
  if (!quiet) {
    status.textContent = '正在保存贡献次数到 Interaction…';
    status.classList.remove('error');
  }
  try {
    const result = await operation();
    if (disposed) return;
    if (quiet && !result.written) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    status.classList.remove('error');
    status.textContent = result.state?.pendingContribution
      ? '本次贡献已预保存；继续编辑仍计为同一次，连续空闲 60 秒后结束。'
      : result.written ? '贡献次数已保存到 Interaction，本次编辑已结束。' : '正在监听文档变化。';
    document.getElementById('updated-at').textContent = new Date().toLocaleTimeString();
  } catch (error) {
    showError(error);
    // Retry persistence only: a presaved session must never increment again.
    scheduleRetry();
  }
}

function checkDay() {
  if (disposed || !idle || dayCheckInFlight) return;
  // Finish a session from the previous day before closing that day's total.
  if (idle.finishIfIdle() || idle.hasPending()) return;
  if (tracker.snapshot().state?.currentDate === localDate()) return;
  dayCheckInFlight = true;
  persist(() => tracker.rollover()).finally(() => { dayCheckInFlight = false; });
}

render();
async function start() {
  if (LOCAL_PREVIEW) {
    status.textContent = '本地外观预览，无飞书数据。文档变化和贡献存储需在飞书宿主中验证。';
    return;
  }
  let stopListening;
  let heightTimer;
  let dayTimer;
  let idleTimer;
  let observer;
  function cleanup() {
    if (disposed) return;
    disposed = true;
    idle?.dispose();
    clearTimeout(retryTimer);
    clearTimeout(heightTimer);
    clearInterval(dayTimer);
    clearInterval(idleTimer);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', checkDay);
    Promise.resolve().then(() => stopListening?.()).catch(() => {}).finally(() => host?.destroy());
  }
  window.addEventListener('pagehide', cleanup, { once: true });
  try {
    host = await connectFeishu();
    if (disposed) { host.destroy(); return; }
    observer = new ResizeObserver(() => {
      clearTimeout(heightTimer);
      heightTimer = setTimeout(() => host.resize().catch(() => {}), 150);
    });
    observer.observe(document.querySelector('.heatmap-card'));
    tracker = createTracker({ ...host, onChange: result => {
      if (!disposed) { render(result); host.resize().catch(() => {}); }
    } });
    await tracker.load();
    if (disposed) return;
    idle = createIdleScheduler({
      restored: tracker.snapshot().state?.pendingContribution,
      presave: session => persist(() => tracker.presave(session)),
      confirm: session => persist(() => tracker.confirm(session)),
      onActivity: session => persist(() => tracker.touch(session), true),
      onError: showError,
    });
    stopListening = await host.listen(event => {
      if (!idle.activity(event)) return;
      idleSeconds.textContent = '0';
      if (!status.classList.contains('error')) status.textContent = '检测到文档变化，空闲 10 秒后预保存，连续空闲 60 秒后结束本次编辑。';
    });
    if (disposed) { await stopListening(); return; }
    idleTimer = setInterval(() => { idleSeconds.textContent = idle.idleSeconds() ?? '—'; }, 1000);
    dayTimer = setInterval(checkDay, 30000);
    document.addEventListener('visibilitychange', checkDay);
    await persist(() => tracker.save());
  } catch (error) {
    showError(error);
    cleanup();
  }
}

start();
