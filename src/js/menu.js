import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { getSettings, patchSettings } from './utils.js';

let currentPort = null;
let portOpen = false;
let baudRate = 115200;
let charSize = 8;
let stopBits = 1;
let parity = 'none';
let flowControl = 'none';

export function initMenu() {
  const comEl = document.getElementById('com-select');
  const comText = document.getElementById('com-select-text');
  const comDropdown = document.getElementById('com-select-dropdown');
  const baudSelect = document.getElementById('baud-select');
  const refreshBtn = document.getElementById('btn-refresh-ports');
  const toggleBtn = document.getElementById('btn-toggle-port');
  const statusEl = document.getElementById('port-status');
  const settingsBtn = document.getElementById('btn-settings');
  const aboutBtn = document.getElementById('btn-about');

  function setComDisabled(d) {
    comEl.classList.toggle('disabled', d);
  }

  function closeComDropdown() {
    comEl.classList.remove('open');
  }

  function toggleComDropdown() {
    if (comEl.classList.contains('disabled')) return;
    comEl.classList.toggle('open');
  }

  async function selectComOption(el) {
    if (!el || comEl.classList.contains('disabled')) return;
    comDropdown.querySelectorAll('.cs-option.selected').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    const val = el.dataset.value || '';
    currentPort = val || null;
    comText.textContent = el.textContent || '— 选择串口 —';
    toggleBtn.disabled = !currentPort;
    closeComDropdown();
    await patchSettings({ currentPort: val });
  }

  async function refresh() {
    try {
      const ports = await invoke('list_ports');
      const saved = await getSettings();
      comDropdown.innerHTML = '';

      const placeholder = document.createElement('div');
      placeholder.className = 'cs-option placeholder';
      placeholder.textContent = '— 选择串口 —';
      placeholder.dataset.value = '';
      placeholder.addEventListener('click', () => selectComOption(placeholder));
      comDropdown.appendChild(placeholder);

      let foundSaved = false;
      ports.forEach(p => {
        const label = p.description ? `${p.name} - ${p.description}` : p.name;
        const opt = document.createElement('div');
        opt.className = 'cs-option';
        opt.textContent = label;
        opt.dataset.value = p.name;
        if (p.name === saved.currentPort) {
          opt.classList.add('selected');
          comText.textContent = label;
          currentPort = saved.currentPort;
          foundSaved = true;
        }
        opt.addEventListener('click', () => selectComOption(opt));
        comDropdown.appendChild(opt);
      });

      if (foundSaved) {
        toggleBtn.disabled = false;
      } else {
        placeholder.classList.add('selected');
        comText.textContent = '— 选择串口 —';
        currentPort = null;
        toggleBtn.disabled = true;
      }
    } catch (e) {
      console.error('list_ports error:', e);
    }
  }

  refresh();

  (async () => {
    const saved = await getSettings();
    baudRate = saved.baudRate || 115200;
    baudSelect.value = String(baudRate);
    charSize = saved.charSize || 8;
    stopBits = saved.stopBits || 1;
    parity = saved.parity || 'none';
    flowControl = saved.flowControl || 'none';
  })();

  comEl.addEventListener('click', (e) => {
    if (e.target.closest('.cs-dropdown')) return;
    toggleComDropdown();
  });

  comEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleComDropdown();
    } else if (e.key === 'Escape') {
      closeComDropdown();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!comEl.classList.contains('open')) {
        comEl.classList.add('open');
      }
      const items = [...comDropdown.querySelectorAll('.cs-option:not(.placeholder)')];
      if (!items.length) return;
      const sel = comDropdown.querySelector('.cs-option.selected');
      const idx = items.indexOf(sel);
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, items.length - 1)
        : Math.max(idx - 1, 0);
      items.forEach(o => o.classList.remove('selected'));
      items[next].classList.add('selected');
      comText.textContent = items[next].textContent;
      currentPort = items[next].dataset.value || null;
      toggleBtn.disabled = !currentPort;
    }
  });

  document.addEventListener('click', (e) => {
    if (!comEl.contains(e.target)) {
      closeComDropdown();
    }
  });

  refreshBtn.addEventListener('click', refresh);

  baudSelect.addEventListener('change', async () => {
    baudRate = parseInt(baudSelect.value);
    await patchSettings({ baudRate });

    if (portOpen) {
      try {
        await invoke('set_baud_rate', {
          path: currentPort,
          baud: baudRate,
          charSize: charSize,
          stopBits: stopBits,
          parity: parity,
          flowControl: flowControl,
        });
      } catch (e) {
        console.error('baud rate change error:', e);
        portOpen = false;
        toggleBtn.textContent = '打开';
        statusEl.className = 'port-status error';
        statusEl.title = '设置失败';
        setComDisabled(false);
        document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: false } }));
      }
    }
  });

  toggleBtn.addEventListener('click', async () => {
    if (portOpen) {
      try {
        await invoke('close_port');
        portOpen = false;
        toggleBtn.textContent = '打开';
        statusEl.className = 'port-status';
        statusEl.title = '未连接';
        setComDisabled(false);
        document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: false } }));
      } catch (e) {
        console.error('close_port error:', e);
      }
    } else {
      if (!currentPort) return;
      try {
        await invoke('open_port', {
          path: currentPort,
          baud: baudRate,
          charSize: charSize,
          stopBits: stopBits,
          parity: parity,
          flowControl: flowControl,
        });
        portOpen = true;
        toggleBtn.textContent = '关闭';
        statusEl.className = 'port-status connected';
        statusEl.title = '已连接';
        setComDisabled(true);
        document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: true } }));
      } catch (e) {
        console.error('open_port error:', e);
        statusEl.className = 'port-status error';
        statusEl.title = '连接失败';
        toggleBtn.disabled = false;
      }
    }
  });

  settingsBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-settings'));
  });

  const serialSettingsBtn = document.getElementById('btn-serial-settings');
  const ssOverlay = document.getElementById('serial-settings-overlay');
  const ssDialog = document.getElementById('serial-settings-dialog');

  function setSegmentedValue(id, value) {
    const container = document.getElementById(id);
    if (!container) return;
    container.querySelectorAll('.segmented-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === value);
    });
  }

  function getSegmentedValue(id) {
    const container = document.getElementById(id);
    if (!container) return '';
    const active = container.querySelector('.segmented-btn.active');
    return active ? active.dataset.value : '';
  }

  ['ss-char-size', 'ss-stop-bits', 'ss-parity', 'ss-flow-control'].forEach(id => {
    const container = document.getElementById(id);
    if (!container) return;
    container.querySelectorAll('.segmented-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  function openSerialSettings() {
    setSegmentedValue('ss-char-size', String(charSize));
    setSegmentedValue('ss-stop-bits', String(stopBits));
    setSegmentedValue('ss-parity', parity);
    setSegmentedValue('ss-flow-control', flowControl);
    ssOverlay.classList.remove('hidden');
  }

  function closeSerialSettings() {
    ssOverlay.classList.add('hidden');
  }

  serialSettingsBtn.addEventListener('click', openSerialSettings);
  document.getElementById('btn-serial-settings-close').addEventListener('click', closeSerialSettings);
  document.getElementById('btn-ss-cancel').addEventListener('click', closeSerialSettings);

  document.getElementById('btn-ss-ok').addEventListener('click', () => {
    charSize = parseInt(getSegmentedValue('ss-char-size'));
    stopBits = parseInt(getSegmentedValue('ss-stop-bits'));
    parity = getSegmentedValue('ss-parity');
    flowControl = getSegmentedValue('ss-flow-control');
    patchSettings({ charSize, stopBits, parity, flowControl });
    closeSerialSettings();
  });

  document.getElementById('btn-ss-restore').addEventListener('click', () => {
    setSegmentedValue('ss-char-size', '8');
    setSegmentedValue('ss-stop-bits', '1');
    setSegmentedValue('ss-parity', 'none');
    setSegmentedValue('ss-flow-control', 'none');
  });

  ssOverlay.addEventListener('click', (e) => {
    if (e.target === ssOverlay) closeSerialSettings();
  });

  aboutBtn.addEventListener('click', async () => {
    const ver = await getVersion();
    alert(`ZCOM 串口调试助手 v${ver}\n基于 Tauri + Rust`);
  });

  document.addEventListener('port-closed', () => {
    portOpen = false;
    toggleBtn.textContent = '打开';
    statusEl.className = 'port-status';
    statusEl.title = '未连接';
    setComDisabled(false);
    document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: false } }));
  });
}

export function isPortOpen() { return portOpen; }
