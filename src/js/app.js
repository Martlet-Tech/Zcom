import { initIcons } from './icons.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { initTitlebar } from './titlebar.js';
import { initMenu, initHelpMenu } from './menu.js';
import { initReceive, clearReceive, setHexDisplay, setShowTimestamp, applyReceiveStyle, setTerminalMode } from './receive.js';
import { createTerminal, destroyTerminal, termFit } from './terminal.js';
import { initBottom } from './bottom.js';
import { initStatusBar } from './statusbar.js';
import { initViewMenu } from './view.js';
import { initSettings } from './settings.js';
import { getSettings, patchSettings } from './utils.js';
import { Keybindings } from './keybindings.js';

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  const mode = settings.mode || 'standard';
  Keybindings.defaults().enable();

  initIcons();
  initTitlebar();
  initMenu();
  initHelpMenu();
  await initReceive();
  await initBottom();
  await initStatusBar();
  await initViewMenu();
  await initSettings();

  // Mode switch handler
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newMode = btn.dataset.mode;
      const isTerminal = newMode === 'terminal';

      setTerminalMode(isTerminal);

      document.getElementById('send-drag-handle').style.display = isTerminal ? 'none' : '';
      document.getElementById('send-area').style.display = isTerminal ? 'none' : '';
      document.getElementById('file-ops').style.display = isTerminal ? 'none' : '';
      document.getElementById('checksum-area').style.display = isTerminal ? 'none' : '';
      document.getElementById('filter-bar').style.display = isTerminal ? 'none' : '';
      document.getElementById('receive-area').style.display = isTerminal ? 'none' : '';

      if (isTerminal) {
        const s = await getSettings();
        createTerminal(s);
      } else {
        destroyTerminal();
      }

      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === newMode));
      await patchSettings({ mode: newMode });
    });
  });

  // Apply initial mode
  if (mode === 'terminal') {
    createTerminal(settings);
    setTerminalMode(true);
    document.getElementById('send-drag-handle').style.display = 'none';
    document.getElementById('send-area').style.display = 'none';
    document.getElementById('file-ops').style.display = 'none';
    document.getElementById('checksum-area').style.display = 'none';
    document.getElementById('filter-bar').style.display = 'none';
    document.getElementById('receive-area').style.display = 'none';
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'terminal'));
  }

  document.addEventListener('clear-receive', clearReceive);
  listen('clear-receive', clearReceive);

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
    if (settings.mode === 'terminal') termFit();
  });

  const multiBtn = document.getElementById('btn-multi');
  if (multiBtn) {
    multiBtn.addEventListener('click', () => {
      invoke('open_multi_string_window').catch(console.error);
    });
  }

});
