import { calendarPage, colorLevel, colorThresholds, dayActivity, addDays, localDate } from './activity.mjs';
import { createTracker } from './tracker.mjs';
import { createIdleScheduler } from './idle.mjs';
import { CONTRIBUTION_IDLE_MINUTES, DEFAULT_CONTRIBUTION_IDLE_MINUTES } from './contribution.mjs';
import { connectFeishu } from './feishu';
import './index.css';

const grid = document.getElementById('heatmap');
const months = document.getElementById('months');
const status = document.getElementById('status');
const recent = document.getElementById('recent-days');
const idleSeconds = document.getElementById('idle-seconds');
const lastEditedAt = document.getElementById('last-edited-at');
const card = document.querySelector('.heatmap-card');
const chartScroll = document.querySelector('.chart-scroll');
const olderPage = document.getElementById('older-page');
const newerPage = document.getElementById('newer-page');
const SAVE_RETRY_MS = 10000;
let selectedPage = 0;
let displayedResult;
let renderedChart;
let host;
let tracker;
let idle;
let retryTimer;
let dayCheckInFlight = false;
let disposed = false;
let previewReady = false;
let previewContributionIdleMinutes = DEFAULT_CONTRIBUTION_IDLE_MINUTES;
let statusMode = 'connecting';

function renderEditingTiming() {
  idleSeconds.textContent = idle?.idleSeconds() ?? '—';
  const timestamp = idle?.lastEditedAt();
  if (timestamp == null) {
    lastEditedAt.textContent = '—';
    return;
  }
  const date = new Date(timestamp);
  lastEditedAt.textContent = `${localDate(date)} ${date.toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })}`;
}

const ruleButtons = CONTRIBUTION_IDLE_MINUTES.map(minutes => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${minutes} 分钟`;
  button.dataset.minutes = minutes;
  button.addEventListener('click', () => {
    if (button.disabled || disposed) return;
    if (LOCAL_PREVIEW) {
      previewContributionIdleMinutes = minutes;
      render(displayedResult);
      return;
    }
    persist(() => tracker.setContributionIdleMinutes(minutes), false, 'configuration');
  });
  document.getElementById('contribution-rules').append(button);
  return button;
});

function currentContributionIdleMinutes() {
  return displayedResult?.state?.contributionIdleMinutes ?? previewContributionIdleMinutes;
}

function sessionStatus() {
  const minutes = currentContributionIdleMinutes();
  if (idle?.hasPending() ?? Boolean(displayedResult?.state?.pendingContribution)) {
    return displayedResult?.state?.pendingContribution
      ? `本次编辑次数已保存。停止编辑未满 ${minutes} 分钟时继续编辑，仍计为同一次。`
      : `已检测到编辑。停止编辑 10 秒后，会记录并保存本次编辑次数。`;
  }
  return '编辑文档后，会自动记录编辑次数。';
}

function renderStatus() {
  if (status.classList.contains('error') || statusMode === 'connecting') return;
  const minutes = currentContributionIdleMinutes();
  if (statusMode === 'preview') {
    status.textContent = `当前为预览模式，编辑间隔为 ${minutes} 分钟。设置仅在当前页面生效，不会保存到飞书。请在飞书文档中使用小组件记录编辑次数。`;
  } else if (statusMode === 'configuration-saving') {
    status.textContent = `正在保存设置，编辑间隔为 ${minutes} 分钟。`;
  } else if (statusMode === 'configuration-saved') {
    status.textContent = `设置已保存，编辑间隔为 ${minutes} 分钟。${sessionStatus()}`;
  } else if (statusMode === 'contribution-saving') {
    status.textContent = '正在保存编辑次数…';
  } else {
    status.textContent = statusMode === 'contribution-saved'
      ? `编辑次数已保存。${sessionStatus()}` : sessionStatus();
  }
}

function describe(day) {
  if (day.status === 'pending') return `${day.delta} · 统计中`;
  if (day.status === 'no-data') return '暂无记录';
  if (day.status === 'future') return '未来日期';
  return `${day.delta} · 已完成`;
}

function updateChartLayout() {
  // Leave room for weekday labels, gaps and the pending cell's outline.
  const cellSize = Math.max(10, Math.floor((chartScroll.clientWidth - 4 - 28 - 52 * 3) / 53 * 1000) / 1000);
  const size = `${cellSize}px`;
  if (card.style.getPropertyValue('--cell-size') !== size) card.style.setProperty('--cell-size', size);
  for (const label of months.children) {
    label.style.visibility = label.scrollWidth > label.clientWidth ? 'hidden' : 'visible';
  }
}

function renderMonths(dates) {
  months.replaceChildren();
  const boundaries = [];
  dates.forEach((date, index) => {
    if (index !== 0 && !date.endsWith('-01')) return;
    const column = Math.floor(index / 7);
    const month = date.slice(0, 7);
    // A partial opening month may share a column with the next month.
    if (boundaries.at(-1)?.column === column) boundaries.pop();
    boundaries.push({ column, month });
  });
  boundaries.forEach(({ column, month }, index) => {
    const label = document.createElement('span');
    const yearBoundary = Number(month.slice(5)) === 1;
    label.textContent = `${yearBoundary ? `${month.slice(0, 4)}年` : ''}${Number(month.slice(5))}月`;
    if (yearBoundary) label.className = 'year-boundary';
    label.style.gridColumn = `${column + 1} / span ${(boundaries[index + 1]?.column ?? 53) - column}`;
    months.append(label);
  });
}

function renderControls(result) {
  const { state, today } = result;
  const minutes = currentContributionIdleMinutes();
  for (const button of ruleButtons) {
    const selected = Number(button.dataset.minutes) === minutes;
    button.disabled = disposed || !(result.loaded || previewReady) || selected;
    button.setAttribute('aria-pressed', String(selected));
  }
  document.getElementById('contribution-rule-explanation').textContent = `停止编辑 10 秒后，编辑次数增加 1 并保存。停止编辑未满 ${minutes} 分钟时继续编辑，仍计为同一次；停止编辑达到 ${minutes} 分钟后，再次编辑会另计一次。保存失败会自动重试。今日次数会继续更新，次日确定最终次数。`;
  renderStatus();
  const latestContributions = state?.latestContributions ?? '—';
  document.getElementById('contribution-summary').textContent = `最近一年共有 ${latestContributions} 次编辑`;
  document.getElementById('latest-contributions').textContent = latestContributions;
  document.getElementById('saved-contributions').textContent = result.savedContributions ?? '—';
  document.getElementById('baseline-contributions').textContent = state?.baselineContributions ?? '—';
  document.getElementById('live-delta').textContent = state?.currentDate === today ? state.latestContributions - state.baselineContributions : '—';
  document.getElementById('current-date').textContent = state?.currentDate ?? '尚未开始';
  document.getElementById('timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('started-on').textContent = state?.startedOn ?? '—';
}

function renderChart({ state, today }) {
  const hasState = Boolean(state);
  const startedOn = state?.startedOn ?? today;
  const delta = state?.currentDate === today ? state.latestContributions - state.baselineContributions : null;
  const history = state?.history ?? {};
  // Snapshots are cloned; compare display values, never session metadata or object identity.
  if (renderedChart && renderedChart.hasState === hasState && renderedChart.startedOn === startedOn
    && renderedChart.today === today && renderedChart.pageIndex === selectedPage && renderedChart.delta === delta) {
    const dates = Object.keys(history);
    if (dates.length === Object.keys(renderedChart.history).length
      && dates.every(date => Object.hasOwn(renderedChart.history, date) && renderedChart.history[date] === history[date])) return;
  }
  const { dates, pageIndex, pageCount } = calendarPage(state?.startedOn ?? today, today, selectedPage);
  selectedPage = pageIndex;
  const thresholds = colorThresholds(history);
  grid.replaceChildren();
  renderMonths(dates);
  dates.forEach(date => {
    const day = dayActivity(state, date, today);
    const level = day.status === 'settled' || day.status === 'pending' ? colorLevel(day.delta, thresholds) : 0;
    const cell = document.createElement('span');
    cell.className = `cell level-${level} ${day.status}`;
    cell.dataset.date = date;
    cell.dataset.status = day.status;
    cell.title = `${date}：编辑次数 ${describe(day)}`;
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  });
  grid.setAttribute('aria-label', `${dates[0]} 至 ${dates.at(-1)} 的每日编辑活跃度；绿色表示编辑次数，今天随编辑次数更新颜色，蓝色轮廓表示今日次数仍在更新。`);
  document.getElementById('pagination').hidden = pageCount === 1;
  document.getElementById('page-number').textContent = `${pageIndex + 1} / ${pageCount}`;
  olderPage.disabled = pageIndex === pageCount - 1;
  newerPage.disabled = pageIndex === 0;
  recent.replaceChildren();
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = addDays(today, offset);
    const day = dayActivity(state, date, today);
    const row = document.createElement('tr');
    for (const value of [date, day.delta ?? '—', date === today ? '统计中' : day.status === 'settled' ? '已完成' : '暂无记录']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    recent.append(row);
  }
  updateChartLayout();
  renderedChart = { hasState, startedOn, today, pageIndex, delta, history: { ...history } };
}

function render(result = { state: null, today: localDate(), savedContributions: null }) {
  displayedResult = result;
  renderControls(result);
  renderChart(result);
}

function changePage(offset) {
  if (disposed) return;
  selectedPage += offset;
  render(displayedResult);
  chartScroll.scrollLeft = 0;
  host?.resize().catch(() => {});
}

olderPage.addEventListener('click', () => changePage(1));
newerPage.addEventListener('click', () => changePage(-1));

function showError(error) {
  if (disposed) return;
  const messages = {
    'Interaction 返回的数据格式无效，已停止统计写入。': '读取的编辑记录格式有误，已停止保存统计数据。',
    'Interaction 读取超时，未写入或重置统计数据。请重新加载小组件；若持续超时，检查 useInteraction 配置和宿主请求错误。': '读取编辑记录超时，统计数据未被修改或重置。请重新加载小组件；若仍无法读取，请联系小组件维护者。',
    'Interaction 统计数据格式无效，已保留原数据。': '编辑记录格式有误，原有记录已保留。',
    'Interaction 统计结构无效，已保留原数据。': '编辑记录结构有误，原有记录已保留。',
    '保存的贡献次数无效，已保留原数据。': '已保存的编辑次数有误，原有记录已保留。',
    '历史结算数据无效，已保留原数据。': '历史编辑记录有误，原有记录已保留。',
    '历史贡献次数与当日基线不一致，已保留原数据。': '历史编辑次数与今日开始前的累计次数不一致，原有记录已保留。',
    '预保存贡献状态无效，已保留原数据。': '本次编辑记录的状态有误，原有记录已保留。',
    '贡献计时规则无效，仅支持 1、3、5、10、30、60 分钟，已保留原数据。': '编辑间隔设置有误，仅支持 1、3、5、10、30、60 分钟，原有记录已保留。',
    '本地日期早于当前统计日期，暂停结算；请检查时区或系统日期。': '设备日期早于当前统计日期，已暂停确定每日编辑次数。请检查设备的时区和日期设置。',
    '贡献日期不能晚于本地今天，且必须是有效日期。': '编辑日期有误，日期不能晚于设备的当前日期。',
    '贡献日期不在已启用的统计区间内。': '编辑日期不在已开始记录的日期范围内。',
    '贡献次数已达到安全整数上限。': '编辑次数已达到支持的最大值。',
  };
  status.textContent = Object.hasOwn(messages, error.message)
    ? messages[error.message] : error.message || '读取或保存编辑记录失败。';
  status.classList.add('error');
}

function scheduleRetry() {
  if (disposed || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    const snapshot = tracker.snapshot();
    const kind = snapshot.state.contributionIdleMinutes !== snapshot.savedContributionIdleMinutes ? 'configuration' : 'contribution';
    persist(() => tracker.save(), false, kind);
  }, SAVE_RETRY_MS);
}

async function persist(operation, quiet = false, kind = 'contribution') {
  if (disposed) return;
  if (!quiet) {
    statusMode = `${kind}-saving`;
    renderStatus();
  }
  try {
    const result = await operation();
    if (disposed) return;
    if (quiet && !result.written) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    status.classList.remove('error');
    statusMode = kind === 'configuration' ? 'configuration-saved' : result.written ? 'contribution-saved' : 'idle';
    renderStatus();
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
  let stopListening;
  let heightTimer;
  let dayTimer;
  let idleTimer;
  let layoutFrame;
  let observer;
  function cleanup() {
    if (disposed) return;
    disposed = true;
    for (const button of ruleButtons) button.disabled = true;
    idle?.dispose();
    clearTimeout(retryTimer);
    clearTimeout(heightTimer);
    clearInterval(dayTimer);
    clearInterval(idleTimer);
    cancelAnimationFrame(layoutFrame);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', checkDay);
    Promise.resolve().then(() => stopListening?.()).catch(() => {}).finally(() => host?.destroy());
  }
  window.addEventListener('pagehide', cleanup, { once: true });
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(layoutFrame);
    // Changing observed dimensions inside the callback would trigger a resize loop.
    layoutFrame = requestAnimationFrame(() => {
      if (disposed) return;
      updateChartLayout();
      if (!host) return;
      clearTimeout(heightTimer);
      heightTimer = setTimeout(() => host.resize().catch(() => {}), 150);
    });
  });
  observer.observe(card);
  if (LOCAL_PREVIEW) {
    previewReady = true;
    statusMode = 'preview';
    render(displayedResult);
    return;
  }
  try {
    host = await connectFeishu();
    if (disposed) { host.destroy(); return; }
    tracker = createTracker({ ...host, onChange: result => {
      if (!disposed) {
        idle?.setContributionIdleMinutes(result.state.contributionIdleMinutes);
        renderEditingTiming();
        render(result);
        host.resize().catch(() => {});
      }
    } });
    await tracker.load();
    if (disposed) return;
    idle = createIdleScheduler({
      restored: tracker.snapshot().state?.pendingContribution,
      contributionIdleMinutes: tracker.snapshot().state.contributionIdleMinutes,
      presave: session => persist(() => tracker.presave(session)),
      confirm: session => persist(() => tracker.confirm(session)),
      onActivity: session => persist(() => tracker.touch(session), true),
      onError: showError,
    });
    stopListening = await host.listen(event => {
      if (!idle.activity(event)) return;
      renderEditingTiming();
      statusMode = 'editing';
      renderStatus();
    });
    if (disposed) { await stopListening(); return; }
    renderEditingTiming();
    idleTimer = setInterval(renderEditingTiming, 1000);
    dayTimer = setInterval(checkDay, 30000);
    document.addEventListener('visibilitychange', checkDay);
    await persist(() => tracker.save());
  } catch (error) {
    showError(error);
    cleanup();
  }
}

start();
