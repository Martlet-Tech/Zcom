import { invoke } from '@tauri-apps/api/core';
import { getSettings, saveSettings } from './utils.js';

let currentPort = null;
let portOpen = false;

export function initMenu() {
  const comSelect = document.getElementById('com-select');
  const refreshBtn = document.getElementById('btn-refresh-ports');
  const toggleBtn = document.getElementById('btn-toggle-port');
  const statusEl = document.getElementById('port-status');
  const settingsBtn = document.getElementById('btn-settings');
  const aboutBtn = document.getElementById('btn-about');

  async function refresh() {
    try {
      const ports = await invoke('list_ports');
      const saved = await getSettings();
      comSelect.innerHTML = '<option value="">— 选择串口 —</option>';
      let foundSaved = false;
      ports.forEach(p => {
        const label = p.description ? `${p.name} - ${p.description}` : p.name;
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = label;
        if (p.name === saved.currentPort) {
          opt.selected = true;
          foundSaved = true;
        }
        comSelect.appendChild(opt);
      });
      if (foundSaved) {
        currentPort = saved.currentPort;
        toggleBtn.disabled = false;
      }
    } catch (e) {
      console.error('list_ports error:', e);
    }
  }

  refresh();

  refreshBtn.addEventListener('click', refresh);

  comSelect.addEventListener('change', async () => {
    currentPort = comSelect.value || null;
    toggleBtn.disabled = !currentPort;
    const s = await getSettings();
    s.currentPort = currentPort || '';
    await saveSettings(s);
  });

  toggleBtn.addEventListener('click', async () => {
    if (portOpen) {
      try {
        await invoke('close_port');
        portOpen = false;
        toggleBtn.textContent = '打开';
        statusEl.textContent = '未连接';
        statusEl.className = 'port-status disconnected';
        comSelect.disabled = false;
        document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: false } }));
      } catch (e) {
        console.error('close_port error:', e);
      }
    } else {
      if (!currentPort) return;
      try {
        await invoke('open_port', { path: currentPort, baud: 115200 });
        portOpen = true;
        toggleBtn.textContent = '关闭';
        statusEl.textContent = '已连接';
        statusEl.className = 'port-status connected';
        comSelect.disabled = true;
        document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: true } }));
      } catch (e) {
        console.error('open_port error:', e);
        statusEl.textContent = '连接失败';
        toggleBtn.disabled = false;
      }
    }
  });

  settingsBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('open-settings'));
  });

  aboutBtn.addEventListener('click', () => {
    alert('ZCOM 串口调试助手 v0.1.0\n基于 Tauri + Rust');
  });

  document.addEventListener('port-closed', () => {
    portOpen = false;
    toggleBtn.textContent = '打开';
    statusEl.textContent = '未连接';
    statusEl.className = 'port-status disconnected';
    comSelect.disabled = false;
    document.dispatchEvent(new CustomEvent('port-state-change', { detail: { open: false } }));
  });
}

export function isPortOpen() { return portOpen; }
