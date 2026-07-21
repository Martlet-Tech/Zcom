import { invoke } from '@tauri-apps/api/core';
import { getSettings, patchSettings, formatByteCount } from './utils.js';

export async function initStatusBar() {
  let portConnected = false;

  const chkHexSend = document.getElementById('chk-hex-send');
  const chkHexDisplay = document.getElementById('chk-hex-display');
  const chkTimestamp = document.getElementById('chk-timestamp');
  const encSelect = document.getElementById('encoding-select');
  const statTx = document.getElementById('stat-tx');
  const statRx = document.getElementById('stat-rx');
  const portInfo = document.getElementById('port-info');

  document.addEventListener('port-state-change', (e) => {
    portConnected = e.detail.open;
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

  setInterval(async () => {
    if (!portConnected) return;
    try {
      const info = await invoke('get_port_info');
      statTx.textContent = `Tx: ${formatByteCount(info.tx)}`;
      statRx.textContent = `Rx: ${formatByteCount(info.rx)}`;
      portInfo.innerHTML = `${info.name} 已连接 ${info.baud} ${info.dataBits}N${info.stopBits}`;
    } catch {
      // ignore
    }
  }, 500);
}
