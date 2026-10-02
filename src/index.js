import { calendarDates, colorLevel, colorThresholds, dayActivity, addDays, localDate } from './activity.mjs';
import { createTracker } from './tracker.mjs';
import { createIdleScheduler } from './idle.mjs';
import { connectFeishu } from './feishu';
import './index.css';

const grid = document.getElementById('heatmap');
const months = document.getElementById('months');
const status = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const saveButton = document.getElementById('save');
const recent = document.getElementById('recent-days');
const idleSeconds = document.getElementById('idle-seconds');
let host;
let tracker;
let current;
let idle;
let busy = 0;
let lastAttemptDate = localDate();

function describe(day) {
  if (day.status === 'pending') return `${day.delta} · pending（未结算）`;
  if (day.status === 'no-data') return '无数据';
  if (day.status === 'future') return '未来日期';
  return `${day.delta} · 已结算`;
}

function render(result = { state: null, today: localDate(), revision: null }) {
  const { state, today, revision } = result;
  const dates = calendarDates(today);
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
    const day = dayActivity(state, date, today, revision);
    const level = day.status === 'settled' ? colorLevel(day.delta, thresholds) : 0;
    const cell = document.createElement('span');
    cell.className = `cell level-${level} ${day.status}`;
    cell.dataset.date = date;
    cell.dataset.status = day.status;
    cell.title = `${date}：revision 增量 ${describe(day)}`;
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  });
  grid.setAttribute('aria-label', `${dates[0]} 至 ${dates.at(-1)} 的每日编辑活跃度；今天 pending，绿色表示历史已结算活跃度。`);
  document.getElementById('date-range').textContent = `${today} · 本地日期`;
  document.getElementById('latest-revision').textContent = revision ?? '—';
  document.getElementById('saved-revision').textContent = result.savedRevision ?? '—';
  document.getElementById('baseline-revision').textContent = state?.baselineRevision ?? '—';
  document.getElementById('live-delta').textContent = state?.currentDate === today && revision !== null ? Math.max(0, revision - state.baselineRevision) : '—';
  document.getElementById('current-date').textContent = state?.currentDate ?? '尚未开始';
  document.getElementById('timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('started-on').textContent = state?.startedOn ?? '—';
  recent.replaceChildren();
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = addDays(today, offset);
    const day = dayActivity(state, date, today, revision);
    const row = document.createElement('tr');
    for (const value of [date, day.delta ?? '—', date === today ? 'pending' : day.status === 'settled' ? '已结算' : '无数据']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    recent.append(row);
  }
}

async function refresh(save = false, options = {}) {
  if (!tracker) return;
  busy += 1;
  lastAttemptDate = localDate();
  refreshButton.disabled = true;
  saveButton.disabled = true;
  status.textContent = save ? '正在保存最新 revision 到 Interaction…' : '正在读取最新 revision…';
  status.classList.remove('error');
  try {
    const result = await (save ? tracker.save(options) : tracker.refresh(options));
    if (result.cancelled) {
      status.textContent = '检测到继续编辑，已延后同步；闲置后自动重试。';
      return;
    }
    current = result;
    render(current);
    status.textContent = current.notice || (save
      ? current.written ? '最新 revision 已保存到 Interaction。' : 'Interaction 已保存当前状态，无需重复写入。'
      : '内存 revision 已更新；闲置 60 秒后自动保存到 Interaction。');
    document.getElementById('updated-at').textContent = new Date().toLocaleTimeString();
  } catch (error) {
    if (error.observation) render({ state: null, ...current, ...error.observation });
    status.textContent = error.message || '读取或保存失败，请重试。';
    status.classList.add('error');
  } finally {
    busy -= 1;
    refreshButton.disabled = busy > 0;
    saveButton.disabled = busy > 0;
    host?.resize().catch(() => {});
  }
}

render();
refreshButton.addEventListener('click', () => refresh());
saveButton.addEventListener('click', () => refresh(true, { canSave: idle.captureWindow() }));

async function start() {
  if (LOCAL_PREVIEW) {
    status.textContent = '本地外观预览，无飞书数据。使用 npm start 在飞书文档内验证真实 revision 和 Interaction。';
    return;
  }
  try {
    host = await connectFeishu();
    let heightTimer;
    new ResizeObserver(() => {
      clearTimeout(heightTimer);
      heightTimer = setTimeout(() => host.resize().catch(() => {}), 150);
    }).observe(document.querySelector('.heatmap-card'));
    tracker = createTracker(host);
    idle = createIdleScheduler({
      refresh: options => refresh(false, options),
      save: options => refresh(true, options),
    });
    function recordActivity() {
      idle.activity();
      idleSeconds.textContent = '0';
    }
    // The displayed counter shares the refresh/save idle window.
    recordActivity();
    await host.listen(recordActivity);
    const idleTimer = setInterval(() => {
      idleSeconds.textContent = String(idle.idleSeconds());
    }, 1000);
    await refresh();
    const dayTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && lastAttemptDate !== localDate()) idle.refreshIfIdle();
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        recordActivity();
      }
    });
    window.addEventListener('pagehide', () => {
      idle.dispose();
      clearInterval(dayTimer);
      clearInterval(idleTimer);
    }, { once: true });
  } catch (error) {
    status.textContent = error.message || '飞书 API 初始化失败。';
    status.classList.add('error');
    host?.resize().catch(() => {});
  }
}

start();
