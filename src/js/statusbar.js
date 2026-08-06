import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getSettings, patchSettings, formatByteCount } from './utils.js';
import { t } from './i18n.js';
import { PortState, portFSM } from './serial-state.js';

export async function initStatusBar() {
  const chkHexSend = document.getElementById('chk-hex-send');
  const chkHexDisplay = document.getElementById('chk-hex-display');
  const chkTimestamp = document.getElementById('chk-timestamp');
  const chkEcho = document.getElementById('chk-echo');
  const encSelect = document.getElementById('encoding-select');
  const statTx = document.getElementById('stat-tx');
  const statRx = document.getElementById('stat-rx');
  const statSel = document.getElementById('stat-sel');
  const portInfo = document.getElementById('port-info');

  /// Connection text + initial counters, pulled once when entering CONNECTED.
  /// TX/RX live updates come from the `io-stats` pipeline event (FSM-free).
  async function onConnected() {
    try {
      const info = await invoke('get_port_info');
      displayTx(info.tx || 0);
      displayRx(info.rx || 0);
      if (info.mode && info.mode !== 0) {
        portInfo.innerHTML = t('statusbar.netConnected', { remote: info.name || info.local || '' });
      } else {
        portInfo.innerHTML = t('statusbar.connectedInfo', { name: info.name, baud: info.baud, dataBits: info.dataBits, stopBits: info.stopBits });
      }
    } catch {
      // ignore
    }
  }

  portFSM.on((state, fsm) => {
    if (state === PortState.RECONNECTING) {
      portInfo.innerHTML = t('statusbar.reconnectingInfo', { name: fsm.portName || '', baud: fsm.baud || '' });
    } else if (state === PortState.CONNECTED) {
      onConnected();
    } else {
      portInfo.innerHTML = `<span>${t('common.disconnected')}</span>`;
    }
  });

  const saved = await getSettings();
  chkHexDisplay.checked = saved.hexDisplay;
  chkTimestamp.checked = saved.showTimestamp;
  chkHexSend.checked = saved.hexSend;
  chkEcho.checked = saved.echoEnabled !== false;
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

  chkEcho.addEventListener('change', async () => {
    await patchSettings({ echoEnabled: chkEcho.checked });
    document.dispatchEvent(new CustomEvent('echo-enabled-change', { detail: { on: chkEcho.checked } }));
  });

  document.addEventListener('settings-applied', (e) => {
    chkEcho.checked = e.detail.echoEnabled !== false;
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
    if (portFSM.state === PortState.RECONNECTING) {
      portInfo.innerHTML = t('statusbar.reconnectingInfo', { name: portFSM.portName || '', baud: portFSM.baud || '' });
    } else if (!portFSM.open) {
      portInfo.innerHTML = `<span>${t('common.disconnected')}</span>`;
    }
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

  // TX/RX from the terminal pipeline: backend Meter emits io-stats (throttled
  // 250ms) as data flows; no FSM gating, survives reload-while-connected.
  listen('io-stats', (e) => {
    const p = e.payload || {};
    displayTx(p.tx || 0);
    displayRx(p.rx || 0);
  });

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
