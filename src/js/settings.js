import { getSettings, saveSettings } from './utils.js';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { setLang, getLang, detectLang } from './i18n.js';

let systemThemeMedia = null;
let systemThemeHandler = null;

function setThemeClass(theme) {
  const html = document.documentElement;
  html.className = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'theme-light' : '')
    : (theme === 'dark' ? '' : `theme-${theme}`);
}

function initSegmented(container, value) {
  const btns = container.querySelectorAll('.segmented-btn');
  btns.forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

function readSegmented(container) {
  const active = container.querySelector('.segmented-btn.active');
  return active ? active.dataset.value : null;
}

function setupSegmentedListener(container) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn || !btn.dataset.value) return;
    container.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
}

async function loadDialogValues() {
  const ss = await getSettings();
  document.getElementById('setting-language').value = ss.language || detectLang();
  document.getElementById('setting-font-size').value = ss.fontSize;
  document.getElementById('setting-receive-font').value = ss.receiveFont;
  document.getElementById('setting-receive-size').value = ss.receiveSize;
  document.getElementById('setting-receive-color').value = ss.receiveColor;
  document.getElementById('setting-bg-color').value = ss.bgColor;
  const segTheme = document.querySelector('.segmented[data-setting="theme"]');
  const segSendNewline = document.querySelector('.segmented[data-setting="sendNewline"]');
  const segLineEnd = document.querySelector('.segmented[data-setting="lineEnding"]');
  const segClose = document.querySelector('.segmented[data-setting="closeBehavior"]');
  if (segTheme) initSegmented(segTheme, ss.theme);
  if (segSendNewline) initSegmented(segSendNewline, ss.sendNewline);
  if (segLineEnd) initSegmented(segLineEnd, ss.lineEnding);
  if (segClose) initSegmented(segClose, ss.closeBehavior);
  const foldCount = document.getElementById('setting-fold-count');
  if (foldCount) foldCount.value = ss.foldRepeatCount;
  const chunkInterval = document.getElementById('setting-chunk-interval');
  if (chunkInterval) chunkInterval.value = ss.sendChunkInterval;
  const chunkSize = document.getElementById('setting-chunk-size');
  if (chunkSize) chunkSize.value = ss.sendChunkSize;
  const mcpEnabled = document.getElementById('setting-mcp-enabled');
  if (mcpEnabled) mcpEnabled.checked = ss.mcpEnabled;
  const mcpPort = document.getElementById('setting-mcp-port');
  if (mcpPort) mcpPort.value = ss.mcpPort;
  const autoReconnect = document.getElementById('setting-auto-reconnect');
  if (autoReconnect) autoReconnect.checked = ss.autoReconnect !== false;
  const reconnectInterval = document.getElementById('setting-reconnect-interval');
  if (reconnectInterval) reconnectInterval.value = ss.reconnectInterval || 1000;
  const echoEnabled = document.getElementById('setting-echo-enabled');
  if (echoEnabled) echoEnabled.checked = ss.echoEnabled !== false;
  const echoPrefix = document.getElementById('setting-echo-prefix');
  if (echoPrefix) echoPrefix.checked = ss.echoPrefix !== false;
  const espIdf = document.getElementById('setting-esp-idf');
  if (espIdf) espIdf.value = ss.espIdfPath || '';
  const espPython = document.getElementById('setting-esp-python');
  if (espPython) espPython.value = ss.espPythonPath || '';
  const espBaud = document.getElementById('setting-esp-baud');
  if (espBaud) espBaud.value = ss.espBaud || 921600;
}

function applyStyles(s) {
  document.documentElement.style.fontSize = s.fontSize + 'px';
  document.documentElement.style.setProperty('--font-size', s.fontSize + 'px');
  document.documentElement.style.setProperty('--receive-font', s.receiveFont);
  document.documentElement.style.setProperty('--receive-size', s.receiveSize + 'px');
  document.documentElement.style.setProperty('--receive-color', s.receiveColor);
  document.documentElement.style.setProperty('--receive-bg', s.bgColor);
  setThemeClass(s.theme);
}

export async function initSettings() {
  const overlay = document.getElementById('settings-overlay');
  const dialog = document.getElementById('settings-dialog');
  const closeBtn = dialog?.querySelector('.dialog-close');
  const closeBtn2 = document.getElementById('setting-close');
  const applyBtn = document.getElementById('setting-apply');
  const fontSize = document.getElementById('setting-font-size');
  const receiveFont = document.getElementById('setting-receive-font');
  const receiveSize = document.getElementById('setting-receive-size');
  const receiveColor = document.getElementById('setting-receive-color');
  const bgColor = document.getElementById('setting-bg-color');

  const segTheme = document.querySelector('.segmented[data-setting="theme"]');
  const segSendNewline = document.querySelector('.segmented[data-setting="sendNewline"]');
  const segLineEnd = document.querySelector('.segmented[data-setting="lineEnding"]');
  const segClose = document.querySelector('.segmented[data-setting="closeBehavior"]');

  setupSegmentedListener(segTheme);
  setupSegmentedListener(segSendNewline);
  setupSegmentedListener(segLineEnd);
  setupSegmentedListener(segClose);

  const s = await getSettings();
  applyStyles(s);
  invoke('set_reconnect_config', { auto: s.autoReconnect !== false, intervalMs: s.reconnectInterval || 1000 }).catch(() => {});
  invoke('set_esp_config', { idfPath: s.espIdfPath || '', pythonPath: s.espPythonPath || '', baud: s.espBaud || 921600 }).catch(() => {});
  await applyMcpSettings(s);
  initEspDetect();
  emit('theme-changed', s.theme);
  document.dispatchEvent(new CustomEvent('settings-applied', { detail: s }));
  document.dispatchEvent(new CustomEvent('send-newline-changed', { detail: { sendNewline: s.sendNewline } }));
  document.dispatchEvent(new CustomEvent('line-ending-changed', { detail: { lineEnding: s.lineEnding } }));
  document.dispatchEvent(new CustomEvent('fold-repeat-changed', { detail: { foldRepeatCount: s.foldRepeatCount } }));

  if (systemThemeMedia) {
    systemThemeMedia.removeEventListener('change', systemThemeHandler);
  }
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: light)');
  systemThemeHandler = () => {
    getSettings().then(ss => {
      if (ss.theme === 'system') setThemeClass('system');
    });
  };
  systemThemeMedia.addEventListener('change', systemThemeHandler);

  async function applySettings() {
    const settings = {
      language: document.getElementById('setting-language').value,
      fontSize: parseInt(fontSize.value) || 14,
      receiveFont: receiveFont.value,
      receiveSize: parseInt(receiveSize.value) || 14,
      receiveColor: receiveColor.value,
      bgColor: bgColor.value,
      theme: segTheme ? readSegmented(segTheme) || 'dark' : 'dark',
      sendNewline: segSendNewline ? readSegmented(segSendNewline) || 'raw' : 'raw',
      lineEnding: segLineEnd ? readSegmented(segLineEnd) || 'crlf' : 'crlf',
      sendChunkInterval: parseInt(document.getElementById('setting-chunk-interval')?.value) ?? 10,
      sendChunkSize: parseInt(document.getElementById('setting-chunk-size')?.value) ?? 1024,
      foldRepeatCount: parseInt(document.getElementById('setting-fold-count').value) || 5,
      closeBehavior: segClose ? readSegmented(segClose) || 'ask' : 'ask',
      mcpEnabled: document.getElementById('setting-mcp-enabled')?.checked ?? false,
      mcpPort: parseInt(document.getElementById('setting-mcp-port')?.value) || 9876,
      autoReconnect: document.getElementById('setting-auto-reconnect')?.checked ?? true,
      reconnectInterval: parseInt(document.getElementById('setting-reconnect-interval')?.value) || 1000,
      echoEnabled: document.getElementById('setting-echo-enabled')?.checked ?? true,
      echoPrefix: document.getElementById('setting-echo-prefix')?.checked ?? true,
      espIdfPath: document.getElementById('setting-esp-idf')?.value ?? '',
      espPythonPath: document.getElementById('setting-esp-python')?.value ?? '',
      espBaud: parseInt(document.getElementById('setting-esp-baud')?.value) || 921600,
    };

    const merged = { ...(await getSettings()), ...settings };
    await saveSettings(merged);
    invoke('set_reconnect_config', { auto: settings.autoReconnect, intervalMs: settings.reconnectInterval }).catch(() => {});
    invoke('set_esp_config', { idfPath: settings.espIdfPath, pythonPath: settings.espPythonPath, baud: settings.espBaud }).catch(() => {});
    setLang(settings.language);
    emit('language-changed', settings.language);
    invoke('set_tray_menu_language', { lang: settings.language }).catch(() => {});
    applyStyles(settings);
    await applyMcpSettings(settings);
    emit('theme-changed', settings.theme);
    document.dispatchEvent(new CustomEvent('settings-applied', { detail: settings }));
    document.dispatchEvent(new CustomEvent('send-newline-changed', { detail: { sendNewline: settings.sendNewline } }));
    document.dispatchEvent(new CustomEvent('line-ending-changed', { detail: { lineEnding: settings.lineEnding } }));
    document.dispatchEvent(new CustomEvent('fold-repeat-changed', { detail: { foldRepeatCount: settings.foldRepeatCount } }));
  }

  async function applyMcpSettings(s) {
    if (s.mcpEnabled) {
      await invoke('mcp_start', { port: s.mcpPort }).catch(() => {});
    } else {
      await invoke('mcp_stop').catch(() => {});
    }
    document.dispatchEvent(new CustomEvent('mcp-status-changed'));
  }

  function initEspDetect() {
    const detectBtn = document.getElementById('btn-esp-detect');
    const idfInput = document.getElementById('setting-esp-idf');
    const pyInput = document.getElementById('setting-esp-python');
    const idfList = document.getElementById('esp-idf-datalist');
    const pyList = document.getElementById('esp-python-datalist');
    if (!detectBtn || !idfInput) return;

    detectBtn.addEventListener('click', async () => {
      try {
        const r = await invoke('detect_esp_paths');
        const idfs = r.idfPaths || [];
        const pys = r.pythonPaths || [];
        idfList.innerHTML = '';
        idfs.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          idfList.appendChild(opt);
        });
        pyList.innerHTML = '';
        pys.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          pyList.appendChild(opt);
        });
        if (idfs.length > 0 && !idfInput.value) idfInput.value = idfs[0];
        if (pys.length > 0 && !pyInput.value) pyInput.value = pys[0];
      } catch (e) {
        console.error('detect esp paths error:', e);
      }
    });
  }

  async function open() {
    await loadDialogValues();
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
  }

  document.addEventListener('open-settings', open);

  closeBtn?.addEventListener('click', close);
  closeBtn2?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('echo-enabled-change', (e) => {
    const el = document.getElementById('setting-echo-enabled');
    if (el) el.checked = e.detail.on;
  });
  applyBtn.addEventListener('click', async () => {
    await applySettings();
    close();
  });
}
