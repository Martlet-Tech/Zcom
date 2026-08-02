import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { getSettings, patchSettings } from './utils.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { t } from './i18n.js';
import { PortState, PortEvent, portFSM } from './serial-state.js';

let currentPort = null;
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

  let statusTitleKey = 'common.disconnected';
  let statusClass = 'port-status';

  function transition(event, payload) {
    try {
      portFSM.transition(event, payload);
    } catch (e) {
      console.warn('port FSM:', e.message);
    }
  }

  function applyPortUI() {
    const s = portFSM.state;
    switch (s) {
      case PortState.CONNECTED:
        statusClass = 'port-status connected';
        statusTitleKey = 'common.connected';
        break;
      case PortState.RECONNECTING:
        statusClass = 'port-status reconnecting';
        statusTitleKey = 'common.reconnecting';
        break;
      default:
        statusClass = 'port-status';
        statusTitleKey = 'common.disconnected';
    }
    toggleBtn.textContent = (s === PortState.CONNECTED || s === PortState.RECONNECTING)
      ? t('common.close') : t('common.open');
    if (s === PortState.CONNECTING || s === PortState.CLOSING) {
      toggleBtn.disabled = true;
    } else if (s === PortState.DISCONNECTED) {
      toggleBtn.disabled = !currentPort;
    } else {
      toggleBtn.disabled = false;
    }
    statusEl.className = statusClass;
    statusEl.title = t(statusTitleKey);
    if (!currentPort && s !== PortState.RECONNECTING) comText.textContent = t('menu.selectPort');
    document.dispatchEvent(new CustomEvent('port-state-change', {
      detail: { open: portFSM.open },
    }));
  }

  portFSM.on(applyPortUI);
  document.addEventListener('i18n-changed', applyPortUI);

  listen('port-reconnecting', (e) => {
    const p = e.payload || {};
    transition(PortEvent.DEVICE_LOST, { portName: p.name || portFSM.portName, baud: p.baud || portFSM.baud });
    if (!comEl.classList.contains('open')) refresh();
  });

  listen('port-reconnected', () => {
    transition(PortEvent.RECONNECTED);
    if (!comEl.classList.contains('open')) refresh();
  });

  function closeComDropdown() {
    comEl.classList.remove('open');
  }

  function toggleComDropdown() {
    comEl.classList.toggle('open');
  }

  async function selectComOption(el) {
    if (!el) return;
    comDropdown.querySelectorAll('.cs-option.selected').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    const val = el.dataset.value || '';
    const prevPort = currentPort;
    currentPort = val || null;
    comText.textContent = el.textContent || t('menu.selectPort');
    closeComDropdown();

    const s = portFSM.state;
    if (s === PortState.CONNECTED || s === PortState.RECONNECTING) {
      if (val === prevPort) {
        await patchSettings({ currentPort: val });
        return;
      }
      if (!val) {
        transition(PortEvent.CLOSE_START, { portName: null });
        try {
          await invoke('close_port');
        } catch (e) {
          console.error('close_port error:', e);
        }
        transition(PortEvent.CLOSED);
        await patchSettings({ currentPort: val });
        return;
      }
      transition(PortEvent.OPEN_START, { portName: val });
      const t0 = Date.now();
      try {
        await invoke('switch_port', {
          path: val,
          baud: baudRate,
          charSize: charSize,
          stopBits: stopBits,
          parity: parity,
          flowControl: flowControl,
        });
        const elapsed = Date.now() - t0;
        if (elapsed < 250) {
          await new Promise(r => setTimeout(r, 250 - elapsed));
        }
        transition(PortEvent.OPEN_OK);
      } catch (e) {
        console.error('switch_port error:', e);
        transition(PortEvent.OPEN_FAIL);
        statusEl.className = 'port-status error';
        statusEl.title = t('common.connectionFailed');
      }
      await patchSettings({ currentPort: val });
      return;
    }

    transition(PortEvent.SELECT, { portName: val || null });
    await patchSettings({ currentPort: val });
  }

  async function refresh() {
    try {
      const ports = await invoke('list_ports');
      const saved = await getSettings();
      comDropdown.innerHTML = '';
      let foundSaved = false;

      if (ports.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'cs-option placeholder';
        placeholder.textContent = t('menu.selectPort');
        placeholder.dataset.value = '';
        placeholder.addEventListener('click', () => selectComOption(placeholder));
        comDropdown.appendChild(placeholder);
        if (portFSM.state !== PortState.RECONNECTING) {
          placeholder.classList.add('selected');
          comText.textContent = t('menu.selectPort');
          currentPort = null;
        } else {
          comText.textContent = currentPort || t('menu.selectPort');
        }
        applyPortUI();
        return;
      }

      ports.forEach(p => {
        const label = p.description ? `${p.name} - ${p.description}` : p.name;
        const opt = document.createElement('div');
        opt.className = 'cs-option';
        opt.textContent = label;
        opt.dataset.value = p.name;
        if (p.name === saved.currentPort || p.name === currentPort) {
          opt.classList.add('selected');
          comText.textContent = label;
          currentPort = p.name;
          foundSaved = true;
        }
        opt.addEventListener('click', () => selectComOption(opt));
        comDropdown.appendChild(opt);
      });

      if (foundSaved) {
        applyPortUI();
      } else if (portFSM.state !== PortState.RECONNECTING) {
        comText.textContent = t('menu.selectPort');
        currentPort = null;
        applyPortUI();
      }
    } catch (e) {
      console.error('list_ports error:', e);
    }
  }

  refresh();

  function updateBaudSelection(rate) {
    baudText.textContent = String(rate);
    baudDropdown.querySelectorAll('.cs-option').forEach(o => {
      o.classList.toggle('selected', parseInt(o.dataset.value) === rate);
    });
  }

  (async () => {
    const saved = await getSettings();
    baudRate = saved.baudRate || 115200;
    updateBaudSelection(baudRate);
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
    if (!baudSelect.contains(e.target)) {
      closeBaudDropdown();
    }
  });

  const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 56000, 57600, 115200, 230400, 460800, 921600];

  const baudText = document.getElementById('baud-select-text');
  const baudDropdown = document.getElementById('baud-select-dropdown');

  function closeBaudDropdown() {
    baudSelect.classList.remove('open');
  }

  function toggleBaudDropdown() {
    baudSelect.classList.toggle('open');
  }

  async function selectBaudOption(el) {
    if (!el) return;
    baudDropdown.querySelectorAll('.cs-option.selected').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    const val = parseInt(el.dataset.value);
    baudRate = val;
    baudText.textContent = String(val);
    closeBaudDropdown();
    await patchSettings({ baudRate });

    if (portFSM.state === PortState.CONNECTED) {
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
        transition(PortEvent.CLOSED);
        statusEl.className = 'port-status error';
        statusEl.title = t('common.settingsFailed');
      }
    }
  }

  BAUD_RATES.forEach(rate => {
    const opt = document.createElement('div');
    opt.className = 'cs-option';
    opt.textContent = String(rate);
    opt.dataset.value = String(rate);
    if (rate === baudRate) opt.classList.add('selected');
    opt.addEventListener('click', () => selectBaudOption(opt));
    baudDropdown.appendChild(opt);
  });

  baudSelect.addEventListener('click', (e) => {
    if (e.target.closest('.cs-dropdown')) return;
    toggleBaudDropdown();
  });

  baudSelect.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleBaudDropdown();
    } else if (e.key === 'Escape') {
      closeBaudDropdown();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!baudSelect.classList.contains('open')) {
        baudSelect.classList.add('open');
      }
      const items = [...baudDropdown.querySelectorAll('.cs-option')];
      if (!items.length) return;
      const sel = baudDropdown.querySelector('.cs-option.selected');
      const idx = items.indexOf(sel);
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, items.length - 1)
        : Math.max(idx - 1, 0);
      items.forEach(o => o.classList.remove('selected'));
      items[next].classList.add('selected');
      baudText.textContent = items[next].textContent;
      baudRate = parseInt(items[next].dataset.value);
    }
  });

  refreshBtn.addEventListener('click', refresh);

  toggleBtn.addEventListener('click', async () => {
    const s = portFSM.state;
    if (s === PortState.CONNECTED || s === PortState.RECONNECTING) {
      transition(PortEvent.CLOSE_START);
      try {
        await invoke('close_port');
      } catch (e) {
        console.error('close_port error:', e);
      }
      transition(PortEvent.CLOSED);
      return;
    }
    if (s === PortState.DISCONNECTED) {
      if (!currentPort) return;
      transition(PortEvent.OPEN_START, { portName: currentPort });
      try {
        await invoke('open_port', {
          path: currentPort,
          baud: baudRate,
          charSize: charSize,
          stopBits: stopBits,
          parity: parity,
          flowControl: flowControl,
        });
        transition(PortEvent.OPEN_OK);
      } catch (e) {
        console.error('open_port error:', e);
        transition(PortEvent.OPEN_FAIL);
        statusEl.className = 'port-status error';
        statusEl.title = t('common.connectionFailed');
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

  document.addEventListener('port-closed', () => {
    transition(PortEvent.CLOSED);
    if (!comEl.classList.contains('open')) refresh();
  });
}

export function initHelpMenu() {
  const wrap = document.getElementById('help-menu-wrap');
  const btn = document.getElementById('btn-help');
  const dd = document.getElementById('help-dropdown');

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('open');
    }
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });

  function buildMcpPrompt(port) {
    return `# ZCOM MCP 服务 — AI Agent 使用指南

ZCOM 是一款串口调试助手，内置 MCP（Model Context Protocol）服务。
AI agent 可通过 MCP 协议实时读取串口数据、查询状态、发送指令。

## 连接配置

在 opencode.json（或 opencode.jsonc）中添加：

\`\`\`json
{
  "mcp": {
    "zcom": {
      "type": "remote",
      "url": "http://localhost:${port}/mcp"
    }
  }
}
\`\`\`

## 可用资源

- serial://receive/content  — 串口接收区的全部文本数据
- serial://port           — 串口连接状态和参数

## 可用工具

- get_receive_content()    — 获取所有接收数据
- get_port_status()        — 获取端口状态（端口名、波特率、连接状态、收发字节数）
- send_serial_data(text, encoding?)  — 通过串口发送数据（encoding: utf-8 或 gbk）
- clear_receive()          — 清空接收区

## 使用示例

你可以这样提问：
- "看看串口收到了什么数据"
- "分析这些报文是什么协议"
- "发一条 AT 指令过去"
- "检查串口连接是否正常"`;
  }

  dd.addEventListener('click', async (e) => {
    const item = e.target.closest('.view-item');
    if (!item) return;
    wrap.classList.remove('open');
    const action = item.dataset.helpAction;
    if (action === 'devtools') {
      try {
        await invoke('open_devtools');
      } catch (err) {
        console.error('open_devtools error:', err);
      }
    } else if (action === 'about') {
      const ver = await getVersion();
      alert(t('menu.aboutText', { ver }));
    } else if (action === 'mcp') {
      const { mcpPort } = await getSettings();
      const textEl = document.getElementById('mcp-prompt-text');
      const overlay = document.getElementById('mcp-prompt-overlay');
      if (!textEl || !overlay) return;
      textEl.value = buildMcpPrompt(mcpPort || 9876);
      overlay.classList.remove('hidden');
    }
  });

  document.getElementById('btn-mcp-prompt-copy')?.addEventListener('click', () => {
    const textEl = document.getElementById('mcp-prompt-text');
    if (!textEl) return;
    textEl.select();
    navigator.clipboard.writeText(textEl.value).catch(() => {});
  });

  function closeMcpPrompt() {
    const overlay = document.getElementById('mcp-prompt-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  document.getElementById('btn-mcp-prompt-close')?.addEventListener('click', closeMcpPrompt);
  document.getElementById('btn-mcp-prompt-close2')?.addEventListener('click', closeMcpPrompt);
  document.getElementById('mcp-prompt-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMcpPrompt();
  });
}

export function isPortOpen() { return portFSM.open; }
