const apiUrl = '/api/machine-metrics';
const pollIntervalMs = 15000;
let refreshInProgress = false;

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function formatDuration(seconds) {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function setPercentage(gaugeId, valueId, percentage) {
  document.getElementById(gaugeId).style.setProperty('--value', Math.min(100, Math.max(0, percentage ?? 0)));
  setText(valueId, percentage == null ? '—' : `${percentage.toFixed(1)}%`);
}

function setMachineState(value) {
  const element = document.getElementById('machineState');
  element.textContent = value;
  element.classList.toggle('running', value === 'Running');
  element.classList.toggle('stopped', value === 'Stopped');
}

const svgNamespace = 'http://www.w3.org/2000/svg';
const chartSeries = [
  { key: 'oeePercent', name: 'OEE', color: '#91caff' },
  { key: 'availabilityPercent', name: 'Availability', color: '#00d66b' },
  { key: 'performancePercent', name: 'Performance', color: '#e87521' },
  { key: 'qualityPercent', name: 'Quality', color: '#ffd52e' }
];

function formatClock(value) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatAxisTime(value, windowStart) {
  const date = new Date(value);
  const start = new Date(windowStart);
  const sameDate = date.getFullYear() === start.getFullYear()
    && date.getMonth() === start.getMonth()
    && date.getDate() === start.getDate();
  return sameDate ? formatClock(date) : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatClock(date)}`;
}

function formatLongDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return `${hours}h ${minutes}m ${remainder}s`;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(svgNamespace, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function renderTrendChart(metrics) {
  const svg = document.getElementById('oeeTrendChart');
  svg.replaceChildren();
  const points = metrics.timeSeries || [];
  const width = 1100;
  const height = 270;
  const margin = { top: 16, right: 24, bottom: 42, left: 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const allValues = points.flatMap(point => chartSeries.map(series => point[series.key]).filter(value => value != null && Number.isFinite(value)));
  const maximum = Math.max(100, ...allValues);
  const yMaximum = Math.max(100, Math.ceil(maximum / 20) * 20);
  const x = index => margin.left + (points.length <= 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
  const y = value => margin.top + plotHeight - value / yMaximum * plotHeight;

  for (let tick = 0; tick <= 5; tick++) {
    const value = yMaximum * tick / 5;
    const lineY = y(value);
    svg.append(svgElement('line', { x1: margin.left, x2: width - margin.right, y1: lineY, y2: lineY, class: 'chart-gridline' }));
    const label = svgElement('text', { x: margin.left - 9, y: lineY + 4, 'text-anchor': 'end', class: 'chart-axis-label' });
    label.textContent = `${Math.round(value)}%`;
    svg.append(label);
  }

  const labelCount = Math.min(5, points.length);
  for (let tick = 0; tick < labelCount; tick++) {
    const index = labelCount <= 1 ? 0 : Math.round(tick * (points.length - 1) / (labelCount - 1));
    const label = svgElement('text', { x: x(index), y: height - 12, 'text-anchor': 'middle', class: 'chart-axis-label' });
    label.textContent = formatAxisTime(points[index].at, metrics.windowStartAt);
    svg.append(label);
  }

  chartSeries.forEach(series => {
    let segment = [];
    const drawSegment = () => {
      if (segment.length > 1) {
        svg.append(svgElement('polyline', {
          points: segment.map(point => `${x(point.index)},${y(point.value)}`).join(' '),
          fill: 'none', stroke: series.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
        }));
      }
      segment.forEach(point => {
        const circle = svgElement('circle', { cx: x(point.index), cy: y(point.value), r: 2.8, fill: series.color });
        const title = svgElement('title');
        title.textContent = `${new Date(points[point.index].at).toLocaleString()} · ${series.name}: ${point.value.toFixed(1)}%`;
        circle.append(title);
        svg.append(circle);
      });
      segment = [];
    };

    points.forEach((point, index) => {
      const value = point[series.key];
      if (value == null || !Number.isFinite(value)) {
        drawSegment();
      } else {
        segment.push({ index, value });
      }
    });
    drawSegment();
  });

  if (allValues.length === 0) {
    const empty = svgElement('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-empty' });
    empty.textContent = 'No sufficiently covered intervals in this reporting window';
    svg.append(empty);
  }
  document.getElementById('chartSummary').textContent = `30-minute intervals · ${points.length} points`;
}

function renderStatusTimeline(metrics) {
  const timeline = document.getElementById('statusTimeline');
  const labels = document.getElementById('timelineLabels');
  timeline.replaceChildren();
  labels.replaceChildren();
  const periods = metrics.statusTimeline || [];
  const totalSeconds = metrics.windowSeconds;
  const totals = { Running: 0, Stopped: 0, Unknown: 0 };

  periods.forEach(period => {
    const duration = Math.max(0, period.durationSeconds);
    totals[period.state] = (totals[period.state] || 0) + duration;
    const segment = document.createElement('div');
    segment.className = `status-segment ${period.state.toLowerCase()}`;
    segment.setAttribute('role', 'listitem');
    segment.style.width = `${totalSeconds > 0 ? duration / totalSeconds * 100 : 0}%`;
    segment.title = `${period.state} · ${new Date(period.startAt).toLocaleString()} – ${new Date(period.endAt).toLocaleString()} · ${formatLongDuration(duration)}`;
    segment.setAttribute('aria-label', segment.title);
    timeline.append(segment);
  });

  for (let percent = 0; percent <= 100; percent += 25) {
    const label = document.createElement('span');
    const tickDate = new Date(new Date(metrics.windowStartAt).getTime() + totalSeconds * 1000 * percent / 100);
    label.textContent = formatAxisTime(tickDate, metrics.windowStartAt);
    label.style.left = `${percent}%`;
    labels.append(label);
  }
  document.getElementById('statusSummary').textContent = `Running ${formatLongDuration(totals.Running)} · Stopped ${formatLongDuration(totals.Stopped)} · No data ${formatLongDuration(totals.Unknown)}`;
}

function updateMetrics(metrics) {
  const hasSampleData = metrics.sampleCount > 0;
  const latestDatabaseRow = metrics.lastSampleAt
    ? new Date(metrics.lastSampleAt).toLocaleString()
    : 'no rows found';

  setPercentage('oeeGauge', 'oeeValue', metrics.oeePercent);
  setPercentage('performanceGauge', 'performanceValue', metrics.performancePercent);
  setText('partsCount', hasSampleData ? new Intl.NumberFormat().format(metrics.partsExecuted) : '—');
  setPercentage('availabilityGauge', 'availabilityValue', metrics.availabilityPercent);
  setPercentage('qualityGauge', 'qualityValue', metrics.qualityPercent);
  setText('windowTime', formatDuration(metrics.windowSeconds));
  setText('runningTime', hasSampleData ? formatDuration(metrics.runningSeconds) : '—');
  setText('startEvents', hasSampleData ? new Intl.NumberFormat().format(metrics.startEvents) : '—');
  setText('stopEvents', hasSampleData ? new Intl.NumberFormat().format(metrics.stopEvents) : '—');
  setMachineState(metrics.machineState);
  setText('selectedWindow', `${new Date(metrics.windowStartAt).toLocaleString()} – ${new Date(metrics.windowEndAt).toLocaleString()}`);
  setText('sampleCount', new Intl.NumberFormat().format(metrics.sampleCount));
  setText('lastSample', metrics.lastWindowSampleAt
    ? `Last sample in selected window: ${new Date(metrics.lastWindowSampleAt).toLocaleString()}`
    : 'Last sample in selected window: none');
  setText('dataCoverage', `Coverage: ${metrics.dataCoveragePercent.toFixed(1)}%`);
  setText('databaseStatus', `LocalDB ${metrics.isDataFresh ? 'fresh' : 'stale'} · latest row ${latestDatabaseRow}`);
  renderTrendChart(metrics);
  renderStatusTimeline(metrics);
}

async function refreshMetrics() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  const selectedDate = document.getElementById('selectedDate').value;
  const shift = document.getElementById('shiftFilter').value;

  try {
    const response = await fetch(`${apiUrl}?date=${encodeURIComponent(selectedDate)}&shift=${encodeURIComponent(shift)}`, {
      cache: 'no-store'
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || result.title || `Metrics request failed (${response.status}).`);
    }
    updateMetrics(result);
  } catch (error) {
    console.error('Unable to refresh machine metrics.', error);
    setPercentage('oeeGauge', 'oeeValue', null);
    setPercentage('performanceGauge', 'performanceValue', null);
    setText('partsCount', '—');
    setPercentage('availabilityGauge', 'availabilityValue', null);
    setMachineState('Unavailable');
    setText('dataCoverage', 'Data coverage unavailable');
    setText('sampleCount', '—');
    setText('lastSample', 'Could not read the selected machine records.');
    setText('windowTime', '—');
    setText('runningTime', '—');
    setText('startEvents', '—');
    setText('stopEvents', '—');
    setText('databaseStatus', error.message);
    document.getElementById('oeeTrendChart').replaceChildren();
    document.getElementById('statusTimeline').replaceChildren();
    setText('chartSummary', 'Chart unavailable');
    setText('statusSummary', 'Machine timeline unavailable');
  } finally {
    refreshInProgress = false;
  }
}

const dateInput = document.getElementById('selectedDate');
const today = new Date();
dateInput.value = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
dateInput.max = dateInput.value;

document.querySelectorAll('.tree-toggle').forEach(toggle => toggle.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  document.getElementById(toggle.getAttribute('aria-controls')).hidden = expanded;
}));

document.querySelectorAll('.machine').forEach(row => row.addEventListener('click', () => {
  document.querySelectorAll('.machine').forEach(item => item.classList.remove('selected'));
  row.classList.add('selected');
}));

document.getElementById('treeSearch')?.addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('.machine').forEach(row => {
    row.hidden = !row.textContent.toLowerCase().includes(query);
  });
  document.querySelectorAll('.tree-node').forEach(node => {
    const hasMatch = [...node.querySelectorAll('.machine')].some(row => !row.hidden);
    node.hidden = Boolean(query) && !hasMatch;
    if (query && hasMatch) {
      const toggle = node.querySelector(':scope > .tree-toggle');
      const children = node.querySelector(':scope > .tree-children');
      if (toggle && children) {
        toggle.setAttribute('aria-expanded', 'true');
        children.hidden = false;
      }
    }
  });
});

dateInput.addEventListener('change', refreshMetrics);
document.getElementById('shiftFilter').addEventListener('change', refreshMetrics);
document.getElementById('refreshStatus').addEventListener('click', refreshMetrics);
void refreshMetrics();
setInterval(refreshMetrics, pollIntervalMs);

document.getElementById('openCalendar')?.addEventListener('click', () => {
  if (typeof dateInput.showPicker === 'function') {
    dateInput.showPicker();
  } else {
    dateInput.focus();
  }
});
