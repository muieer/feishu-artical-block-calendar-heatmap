import { weeks, startDate, counts } from './data';
import './index.css';

const grid = document.getElementById('heatmap');
const months = document.getElementById('months');
const start = Date.parse(`${startDate}T00:00:00Z`);
let previousMonth = -1;

weeks.forEach((week, column) => {
  const firstDay = new Date(start + column * 7 * 86400000);
  const month = firstDay.getUTCMonth();
  const label = document.createElement('span');
  label.textContent = month !== previousMonth ? `${month + 1}月` : '';
  label.style.gridColumn = String(column + 1);
  months.append(label);
  previousMonth = month;

  [...week].forEach((level, row) => {
    const date = new Date(start + (column * 7 + row) * 86400000);
    const cell = document.createElement('span');
    cell.className = `cell level-${level}`;
    cell.title = `${date.toISOString().slice(0, 10)}：${counts[Number(level)]} 次（示例数据）`;
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  });
});
