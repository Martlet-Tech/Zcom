import { getSettings, saveSettings } from './utils.js';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { setLang, detectLang, t } from './i18n.js';

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
  const showEscapes = document.getElementById('setting-show-escapes');
  if (showEscapes) showEscapes.checked = ss.showEscapes !== false;
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

/// Saves one setting key immediately and applies its side effects.
async function saveSetting(key, value) {
  const s = { ...(await getSettings()), [key]: value };
  await saveSettings(s);

  switch (key) {
    case 'language':
      setLang(s.language);
      emit('language-changed', s.language);
      invoke('set_tray_menu_language', { lang: s.language }).catch(() => {});
      break;
    case 'theme':
      applyStyles(s);
      emit('theme-changed', s.theme);
      break;
    case 'fontSize':
    case 'receiveFont':
    case 'receiveSize':
    case 'receiveColor':
    case 'bgColor':
      applyStyles(s);
      break;
    case 'sendNewline':
      document.dispatchEvent(new CustomEvent('send-newline-changed', { detail: { sendNewline: s.sendNewline } }));
      break;
    case 'lineEnding':
      document.dispatchEvent(new CustomEvent('line-ending-changed', { detail: { lineEnding: s.lineEnding } }));
      break;
    case 'foldRepeatCount':
      document.dispatchEvent(new CustomEvent('fold-repeat-changed', { detail: { foldRepeatCount: s.foldRepeatCount } }));
      break;
    case 'echoEnabled':
      document.dispatchEvent(new CustomEvent('echo-enabled-change', { detail: { on: s.echoEnabled } }));
      break;
    case 'autoReconnect':
    case 'reconnectInterval':
      invoke('set_reconnect_config', {
        auto: s.autoReconnect !== false,
        intervalMs: s.reconnectInterval || 1000,
      }).catch(() => {});
      break;
    case 'mcpEnabled':
    case 'mcpPort':
      await applyMcpSettings(s);
      break;
    case 'espIdfPath':
    case 'espPythonPath':
    case 'espBaud':
      invoke('set_esp_config', {
        idfPath: s.espIdfPath || '',
        pythonPath: s.espPythonPath || '',
        baud: s.espBaud || 921600,
      }).catch(() => {});
      break;
  }

  document.dispatchEvent(new CustomEvent('settings-applied', { detail: s }));
}

function bindChange(id, key, parse = v => v) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', async () => {
    const v = parse(el.value);
    if (v === undefined) return;
    try {
      await saveSetting(key, v);
    } catch (e) {
      console.error(`save ${key} error:`, e);
    }
  });
}

export async function initSettings() {
  const overlay = document.getElementById('settings-overlay');
  const dialog = document.getElementById('settings-dialog');
  const closeBtn = dialog?.querySelector('.dialog-close');
  const closeBtn2 = document.getElementById('setting-close');

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

  // ===== tabs =====
  const tabs = dialog?.querySelectorAll('.settings-tab');
  const panes = dialog?.querySelectorAll('.settings-pane');
  tabs?.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panes?.forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab.dataset.tab));
    });
  });

  // ===== instant-save bindings =====
  bindChange('setting-language', 'language');
  bindChange('setting-font-size', 'fontSize', v => parseInt(v) || 14);
  bindChange('setting-receive-font', 'receiveFont');
  bindChange('setting-receive-size', 'receiveSize', v => parseInt(v) || 14);
  bindChange('setting-receive-color', 'receiveColor');
  bindChange('setting-bg-color', 'bgColor');
  bindChange('setting-chunk-interval', 'sendChunkInterval', v => parseInt(v));
  bindChange('setting-chunk-size', 'sendChunkSize', v => parseInt(v));
  bindChange('setting-fold-count', 'foldRepeatCount', v => parseInt(v) || 5);
  bindChange('setting-reconnect-interval', 'reconnectInterval', v => parseInt(v) || 1000);
  bindChange('setting-mcp-port', 'mcpPort', v => parseInt(v) || 9876);
  bindChange('setting-esp-idf', 'espIdfPath');
  bindChange('setting-esp-python', 'espPythonPath');
  bindChange('setting-esp-baud', 'espBaud', v => parseInt(v) || 921600);

  const bindBool = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      try {
        await saveSetting(key, el.checked);
      } catch (e) {
        console.error(`save ${key} error:`, e);
      }
    });
  };
  bindBool('setting-echo-enabled', 'echoEnabled');
  bindBool('setting-echo-prefix', 'echoPrefix');
  bindBool('setting-show-escapes', 'showEscapes');
  bindBool('setting-auto-reconnect', 'autoReconnect');
  bindBool('setting-mcp-enabled', 'mcpEnabled');

  const bindSegmented = (container, key) => {
    if (!container) return;
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('.segmented-btn');
      if (!btn || !btn.dataset.value) return;
      try {
        await saveSetting(key, btn.dataset.value);
      } catch (err) {
        console.error(`save ${key} error:`, err);
      }
    });
  };
  bindSegmented(segTheme, 'theme');
  bindSegmented(segSendNewline, 'sendNewline');
  bindSegmented(segLineEnd, 'lineEnding');
  bindSegmented(segClose, 'closeBehavior');

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
        if (idfs.length > 0 && !idfInput.value) {
          idfInput.value = idfs[0];
          saveSetting('espIdfPath', idfs[0]).catch(() => {});
        }
        if (pys.length > 0 && !pyInput.value) {
          pyInput.value = pys[0];
          saveSetting('espPythonPath', pys[0]).catch(() => {});
        }
      } catch (e) {
        console.error('detect esp paths error:', e);
      }
    });

    const browseIdfBtn = document.getElementById('btn-esp-browse-idf');
    browseIdfBtn?.addEventListener('click', async () => {
      const dir = await open({ directory: true, multiple: false }).catch(() => null);
      if (dir) {
        idfInput.value = dir;
        saveSetting('espIdfPath', dir).catch(() => {});
      }
    });

    const browsePyBtn = document.getElementById('btn-esp-browse-py');
    browsePyBtn?.addEventListener('click', async () => {
      const file = await open({
        multiple: false,
        filters: [{ name: 'python.exe', extensions: ['exe'] }],
      }).catch(() => null);
      if (file) {
        pyInput.value = file;
        saveSetting('espPythonPath', file).catch(() => {});
      }
    });

    const checkBtn = document.getElementById('btn-esp-check');
    const resultEl = document.getElementById('esp-check-result');
    if (checkBtn && resultEl) {
      const keyLabels = {
        idfDir: t('esp.chkIdfDir'),
        idfPy: t('esp.chkIdfPy'),
        exportBat: t('esp.chkExportBat'),
        activate: t('esp.chkActivate'),
        python: t('esp.chkPython'),
        probe: t('esp.chkProbe'),
      };
      checkBtn.addEventListener('click', async () => {
        resultEl.classList.remove('hidden');
        resultEl.innerHTML = `<div class="esp-check-status">${t('esp.checking')}</div>`;
        checkBtn.disabled = true;
        try {
          const r = await invoke('esp_check_paths', {
            idfPath: idfInput.value.trim(),
            pythonPath: pyInput.value.trim(),
          });
          const rows = (r.items || []).map(it => {
            const label = keyLabels[it.key] || it.key;
            const mark = it.ok ? '✓' : '✗';
            const detail = it.detail ? `<div class="esp-check-detail">${escapeHtml(it.detail)}</div>` : '';
            return `<div class="esp-check-row ${it.ok ? 'ok' : 'bad'}">${mark} ${label}${detail}</div>`;
          }).join('');
          const status = r.ok
            ? `<div class="esp-check-status ok">${t('esp.checkUsable')}</div>`
            : `<div class="esp-check-status bad">${t('esp.checkUnusable')}</div>`;
          const copyBtn = `<button class="small-btn" id="btn-esp-copy-result">${t('esp.copyResult')}</button>`;
          resultEl.innerHTML = `<div class="esp-check-toolbar">${status}${copyBtn}</div>` + rows;
          const copyBtnEl = document.getElementById('btn-esp-copy-result');
          copyBtnEl?.addEventListener('click', () => {
            const text = Array.from(resultEl.querySelectorAll('.esp-check-status, .esp-check-row'))
              .map(el => el.textContent.trim())
              .filter(Boolean)
              .join('\n');
            navigator.clipboard.writeText(text).catch(() => {});
            copyBtnEl.textContent = '✓';
            setTimeout(() => { copyBtnEl.textContent = t('esp.copyResult'); }, 1200);
          });
        } catch (e) {
          resultEl.innerHTML = `<div class="esp-check-status bad">${escapeHtml(String(e))}</div>`;
        } finally {
          checkBtn.disabled = false;
        }
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function openSettingsDialog() {
    await loadDialogValues();
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
  }

  document.addEventListener('open-settings', openSettingsDialog);

  closeBtn?.addEventListener('click', close);
  closeBtn2?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('echo-enabled-change', (e) => {
    const el = document.getElementById('setting-echo-enabled');
    if (el) el.checked = e.detail.on;
  });
}
