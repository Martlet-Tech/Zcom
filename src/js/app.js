import { initIcons } from './icons.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { initTitlebar } from './titlebar.js';
import { initMenu, initHelpMenu } from './menu.js';
import { initReceive, clearReceive, setHexDisplay, setShowTimestamp, applyReceiveStyle, isTerminalMode, setTerminalMode } from './receive.js';
import { createTerminal, destroyTerminal, termFit } from './terminal.js';
import { initBottom } from './bottom.js';
import { initStatusBar } from './statusbar.js';
import { initViewMenu } from './view.js';
import { initSettings } from './settings.js';
import { getSettings, patchSettings } from './utils.js';
import { Keybindings } from './keybindings.js';
import { t, setLang, applyI18n, getLang, detectLang } from './i18n.js';

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  const mode = settings.mode || 'standard';
  Keybindings.defaults().enable();

  setLang(settings.language || detectLang());
  applyI18n();
  invoke('set_tray_menu_language', { lang: getLang() }).catch(() => {});
  document.addEventListener('i18n-changed', applyI18n);

  initIcons();
  initTitlebar();
  initMenu();
  initHelpMenu();
  await initReceive();
  await initBottom();
  await initStatusBar();
  await initViewMenu();
  await initSettings();

  function applyTerminalUI(isTerminal) {
    const ids = ['send-drag-handle', 'send-area', 'file-ops', 'checksum-area', 'filter-bar', 'receive-area'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = isTerminal ? 'none' : '';
    });

    const statusEl = document.getElementById('status-hide-terminal');
    if (statusEl) statusEl.style.display = isTerminal ? 'none' : '';

    document.querySelectorAll('.view-item').forEach(item => {
      item.classList.toggle('disabled', isTerminal);
    });

    document.querySelectorAll('.mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === (isTerminal ? 'terminal' : 'standard')));
  }

  // Mode switch handler
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newMode = btn.dataset.mode;
      const isTerminal = newMode === 'terminal';

      const s = await getSettings();
      setTerminalMode(isTerminal);
      applyTerminalUI(isTerminal);

      if (isTerminal) {
        createTerminal(s);
      } else {
        destroyTerminal();
      }

      await patchSettings({ mode: newMode });
    });
  });

  // Apply initial mode
  if (mode === 'terminal') {
    createTerminal(settings);
    setTerminalMode(true);
    applyTerminalUI(true);
  }

  document.addEventListener('clear-receive', clearReceive);
  listen('clear-receive', clearReceive);

  document.addEventListener('open-monitor', async () => {
    const s = await getSettings();
    setTerminalMode(true);
    applyTerminalUI(true);
    createTerminal(s);
    await patchSettings({ mode: 'terminal' });
  });

  document.addEventListener('hex-display-change', (e) => {
    setHexDisplay(e.detail.on);
  });

  document.addEventListener('timestamp-change', (e) => {
    setShowTimestamp(e.detail.on);
  });

  document.addEventListener('settings-applied', (e) => {
    applyReceiveStyle(e.detail);
    import('./terminal.js').then(m => m.updateTerminalTheme(e.detail));
  });

  // Resize terminal when window resizes
  window.addEventListener('resize', () => {
    if (isTerminalMode) termFit();
  });

  const multiBtn = document.getElementById('btn-multi');
  if (multiBtn) {
    multiBtn.addEventListener('click', () => {
      invoke('open_multi_string_window').catch(console.error);
    });
  }

});
