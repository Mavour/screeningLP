document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});

async function refreshBins(details) {
  if (!(details instanceof HTMLDetailsElement) || !details.open || !details.dataset.positionBins ||
      details.dataset.loading === 'true' || Number(details.dataset.loadedAt) + 45000 > Date.now()) return;
  const chart = details.querySelector('.bin-detail-content');
  chart.querySelector('.bin-read-status')?.remove();
  const message = document.createElement('small');
  message.className = 'bin-read-status';
  message.textContent = 'Reading confirmed Solana bins…';
  chart.append(message);
  details.dataset.loading = 'true';
  try {
    const url = location.origin + '/web/positions/' + encodeURIComponent(details.dataset.positionBins) + '/bins';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Bins unavailable');
    const data = await response.json();
    const cell = details.closest('.position-range');
    cell.querySelector('.bin-range')?.remove();
    details.insertAdjacentHTML('beforebegin', data.range);
    cell.querySelector('.range-strategy').innerHTML = data.strategy;
    chart.innerHTML = data.chart;
    details.dataset.loadedAt = String(Date.now());
  } catch {
    message.textContent = 'On-chain bins unavailable. Reopen to retry.';
  } finally {
    delete details.dataset.loading;
  }
}

document.addEventListener('toggle', event => refreshBins(event.target), true);

const radarState = document.querySelector('[data-radar-state]');
if (radarState) {
  const stateLabel = { live: 'LIVE · SOLANA', syncing: 'SYNCING', degraded: 'PARTIAL DATA', offline: 'WORKER OFFLINE' };
  let refreshing = false;

  function updateStatus(status, updatedAt) {
    radarState.dataset.radarState = status;
    radarState.querySelector('.radar-state').textContent = stateLabel[status];
    const time = radarState.querySelector('time');
    if (updatedAt) time.textContent = new Date(updatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function isUsingPage(main) {
    return main.querySelector('details[open], :focus') ||
      [...main.querySelectorAll('form input')].some(input => input.type === 'checkbox' ?
        input.checked !== input.defaultChecked : input.value !== input.defaultValue);
  }

  async function refreshRadar() {
    if (document.hidden || refreshing) return;
    refreshing = true;
    try {
      const response = await fetch(location.origin + '/web/public-status', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Radar status unavailable');
      const health = await response.json();
      updateStatus(health.status, health.latestDataAt);
      const main = document.querySelector('main');
      if (!main) return;
      const openBins = main.querySelectorAll('details[data-position-bins][open]');
      if (health.running) [...openBins].slice(0, 3).forEach(refreshBins);
      if (health.revision === document.body.dataset.radarRevision || isUsingPage(main)) return;

      const page = await fetch(location.origin + location.pathname + location.search, { signal: AbortSignal.timeout(8000) });
      if (!page.ok || isUsingPage(main)) return;
      const updated = new DOMParser().parseFromString(await page.text(), 'text/html');
      const next = updated.querySelector('main');
      if (!next || isUsingPage(main)) return;
      const offsets = [...main.querySelectorAll('.scroll')].map(el => el.scrollLeft);
      main.replaceWith(next);
      next.querySelectorAll('.scroll').forEach((el, index) => { el.scrollLeft = offsets[index] ?? 0; });
      document.body.dataset.radarRevision = updated.body.dataset.radarRevision ?? health.revision;
    } catch {
      updateStatus('degraded');
    } finally {
      refreshing = false;
    }
  }

  setInterval(refreshRadar, 20000);
  document.addEventListener('visibilitychange', refreshRadar);
}
