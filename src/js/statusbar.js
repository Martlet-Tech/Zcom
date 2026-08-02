import { invoke } from '@tauri-apps/api/core';
import { getSettings, patchSettings, formatByteCount } from './utils.js';
import { t } from './i18n.js';

export async function initStatusBar() {
  let portConnected = false;

  const chkHexSend = document.getElementById('chk-hex-send');
  const chkHexDisplay = document.getElementById('chk-hex-display');
  const chkTimestamp = document.getElementById('chk-timestamp');
  const encSelect = document.getElementById('encoding-select');
  const statTx = document.getElementById('stat-tx');
  const statRx = document.getElementById('stat-rx');
  const statSel = document.getElementById('stat-sel');
  const portInfo = document.getElementById('port-info');

  document.addEventListener('port-state-change', (e) => {
    portConnected = e.detail.open;
    if (!e.detail.open) portInfo.innerHTML = `<span>${t('common.disconnected')}</span>`;
  });

  const saved = await getSettings();
  chkHexDisplay.checked = saved.hexDisplay;
  chkTimestamp.checked = saved.showTimestamp;
  chkHexSend.checked = saved.hexSend;
  encSelect.value = saved.encoding || 'utf-8';

  chkHexSend.addEventListener('change', async () => {
    await patchSettings({ hexSend: chkHexSend.checked });
    document.dispatchEvent(new CustomEvent('hex-send-change', { detail: { on: chkHexSend.checked } }));
  });

  chkHexDisplay.addEventListener('change', async () => {
    await patchSettings({ hexDisplay: chkHexDisplay.checked });
    document.dispatchEvent(new CustomEvent('hex-display-change', { detail: { on: chkHexDisplay.checked } }));
  });

  chkTimestamp.addEventListener('change', async () => {
    await patchSettings({ showTimestamp: chkTimestamp.checked });
    document.dispatchEvent(new CustomEvent('timestamp-change', { detail: { on: chkTimestamp.checked } }));
  });

  encSelect.addEventListener('change', async () => {
    await patchSettings({ encoding: encSelect.value });
    document.dispatchEvent(new CustomEvent('encoding-change', { detail: { encoding: encSelect.value } }));
  });

  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('hex-display-change', { detail: { on: chkHexDisplay.checked } }));
    document.dispatchEvent(new CustomEvent('timestamp-change', { detail: { on: chkTimestamp.checked } }));
  }, 0);

  statTx.dataset.mode = 'fmt';
  statRx.dataset.mode = 'fmt';
  statTx.title = t('common.doubleClickCopy');
  statRx.title = t('common.doubleClickCopy');

  document.addEventListener('i18n-changed', () => {
    statTx.title = t('common.doubleClickCopy');
    statRx.title = t('common.doubleClickCopy');
    if (!portConnected) portInfo.innerHTML = `<span>${t('common.disconnected')}</span>`;
  });

  function displayTx(raw) {
    statTx.dataset.raw = raw;
    statTx.textContent = statTx.dataset.mode === 'raw'
      ? `Tx: ${raw}` : `Tx: ${formatByteCount(raw)}`;
  }
  function displayRx(raw) {
    statRx.dataset.raw = raw;
    statRx.textContent = statRx.dataset.mode === 'raw'
      ? `Rx: ${raw}` : `Rx: ${formatByteCount(raw)}`;
  }

  let txClickTimer, rxClickTimer;

  statTx.addEventListener('click', () => {
    if (txClickTimer) { clearTimeout(txClickTimer); txClickTimer = null; return; }
    txClickTimer = setTimeout(() => {
      txClickTimer = null;
      statTx.dataset.mode = statTx.dataset.mode === 'raw' ? 'fmt' : 'raw';
      displayTx(+statTx.dataset.raw);
    }, 300);
  });
  statTx.addEventListener('dblclick', () => {
    if (txClickTimer) { clearTimeout(txClickTimer); txClickTimer = null; }
    navigator.clipboard.writeText(statTx.textContent.replace('Tx: ', ''));
  });

  statRx.addEventListener('click', () => {
    if (rxClickTimer) { clearTimeout(rxClickTimer); rxClickTimer = null; return; }
    rxClickTimer = setTimeout(() => {
      rxClickTimer = null;
      statRx.dataset.mode = statRx.dataset.mode === 'raw' ? 'fmt' : 'raw';
      displayRx(+statRx.dataset.raw);
    }, 300);
  });
  statRx.addEventListener('dblclick', () => {
    if (rxClickTimer) { clearTimeout(rxClickTimer); rxClickTimer = null; }
    navigator.clipboard.writeText(statRx.textContent.replace('Rx: ', ''));
  });

  setInterval(async () => {
    if (!portConnected) return;
    try {
      const info = await invoke('get_port_info');
      displayTx(info.tx);
      displayRx(info.rx);
      portInfo.innerHTML = t('statusbar.connectedInfo', { name: info.name, baud: info.baud, dataBits: info.dataBits, stopBits: info.stopBits });
    } catch {
      // ignore
    }
  }, 500);

  document.addEventListener('selection-bytes-changed', (e) => {
    const bytes = e.detail.bytes;
    if (bytes !== null) {
      statSel.textContent = `Sel: ${formatByteCount(bytes)}`;
      statSel.classList.remove('hidden');
    } else {
      statSel.classList.add('hidden');
    }
  });
}
