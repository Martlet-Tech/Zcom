import { invoke } from '@tauri-apps/api/core';
import { getSettings, saveSettings, formatByteCount } from './utils.js';

export async function initStatusBar() {
  const chkHexSend = document.getElementById('chk-hex-send');
  const chkHexDisplay = document.getElementById('chk-hex-display');
  const chkTimestamp = document.getElementById('chk-timestamp');
  const encSelect = document.getElementById('encoding-select');
  const statTx = document.getElementById('stat-tx');
  const statRx = document.getElementById('stat-rx');
  const portInfo = document.getElementById('port-info');

  const saved = await getSettings();
  chkHexDisplay.checked = saved.hexDisplay;
  chkTimestamp.checked = saved.showTimestamp;
  chkHexSend.checked = saved.hexSend;
  encSelect.value = saved.encoding || 'utf-8';

  chkHexSend.addEventListener('change', async () => {
    const s = await getSettings();
    s.hexSend = chkHexSend.checked;
    await saveSettings(s);
    document.dispatchEvent(new CustomEvent('hex-send-change', { detail: { on: chkHexSend.checked } }));
  });

  chkHexDisplay.addEventListener('change', async () => {
    const s = await getSettings();
    s.hexDisplay = chkHexDisplay.checked;
    await saveSettings(s);
    document.dispatchEvent(new CustomEvent('hex-display-change', { detail: { on: chkHexDisplay.checked } }));
  });

  chkTimestamp.addEventListener('change', async () => {
    const s = await getSettings();
    s.showTimestamp = chkTimestamp.checked;
    await saveSettings(s);
    document.dispatchEvent(new CustomEvent('timestamp-change', { detail: { on: chkTimestamp.checked } }));
  });

  encSelect.addEventListener('change', async () => {
    const s = await getSettings();
    s.encoding = encSelect.value;
    await saveSettings(s);
  });

  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('hex-display-change', { detail: { on: chkHexDisplay.checked } }));
    document.dispatchEvent(new CustomEvent('timestamp-change', { detail: { on: chkTimestamp.checked } }));
  }, 0);

  setInterval(async () => {
    try {
      const info = await invoke('get_port_info');
      statTx.textContent = `Tx: ${formatByteCount(info.tx)}`;
      statRx.textContent = `Rx: ${formatByteCount(info.rx)}`;
      if (info.connected) {
        portInfo.innerHTML = `${info.name} 已连接 ${info.baud} ${info.dataBits}N${info.stopBits}`;
      } else {
        portInfo.innerHTML = '未连接';
      }
    } catch {
      // ignore
    }
  }, 500);
}
