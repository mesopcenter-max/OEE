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
  document.getElementById(gaugeId).style.setProperty('--value', percentage ?? 0);
  setText(valueId, percentage == null ? '—' : `${percentage.toFixed(1)}%`);
}

function setMachineState(value) {
  const element = document.getElementById('machineState');
  element.textContent = value;
  element.classList.toggle('running', value === 'Running');
  element.classList.toggle('stopped', value === 'Stopped');
}

function updateMetrics(metrics) {
  const hasSampleData = metrics.sampleCount > 0;
  const latestDatabaseRow = metrics.lastSampleAt
    ? new Date(metrics.lastSampleAt).toLocaleString()
    : 'no rows found';

  setText('oeeValue', metrics.oeePercent == null ? '—' : `${metrics.oeePercent.toFixed(1)}%`);
  setText('performanceValue', metrics.performancePercent == null ? '—' : `${metrics.performancePercent.toFixed(1)}%`);
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
    setText('oeeValue', '—');
    setText('performanceValue', '—');
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
  } finally {
    refreshInProgress = false;
  }
}

const dateInput = document.getElementById('selectedDate');
const today = new Date();
dateInput.value = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
dateInput.max = dateInput.value;

document.querySelectorAll('.machine').forEach(row => row.addEventListener('click', () => {
  document.querySelectorAll('.machine').forEach(item => item.classList.remove('selected'));
  row.classList.add('selected');
}));

document.getElementById('treeSearch')?.addEventListener('input', event => {
  const query = event.target.value.toLowerCase();
  document.querySelectorAll('.machine').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(query) ? 'flex' : 'none';
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
