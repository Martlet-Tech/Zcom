import { invoke } from '@tauri-apps/api/core';
import { initTitlebar } from './titlebar.js';
import { initMenu } from './menu.js';
import { initReceive, clearReceive, setHexDisplay, setShowTimestamp, applyReceiveStyle } from './receive.js';
import { initBottom } from './bottom.js';
import { initStatusBar } from './statusbar.js';
import { initSettings } from './settings.js';
import { getSettings, saveSettings } from './utils.js';

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();

  initTitlebar();
  initMenu();
  await initReceive();
  await initBottom();
  await initStatusBar();
  await initSettings();

  document.addEventListener('clear-receive', clearReceive);

  document.addEventListener('hex-display-change', (e) => {
    setHexDisplay(e.detail.on);
  });

  document.addEventListener('timestamp-change', (e) => {
    setShowTimestamp(e.detail.on);
  });

  document.addEventListener('settings-applied', (e) => {
    applyReceiveStyle(e.detail);
  });

  applyReceiveStyle(settings);

  const toggleBtn = document.getElementById('btn-toggle-panel');
  const content = document.getElementById('content');
  if (toggleBtn && content) {
    if (settings.panelHidden) {
      content.classList.add('panel-hidden');
      toggleBtn.textContent = '▲';
      toggleBtn.title = '展开底部面板';
    }
    toggleBtn.addEventListener('click', async () => {
      const hidden = content.classList.toggle('panel-hidden');
      toggleBtn.textContent = hidden ? '▲' : '▼';
      toggleBtn.title = hidden ? '展开底部面板' : '折叠底部面板';
      const s = await getSettings();
      s.panelHidden = hidden;
      await saveSettings(s);
    });
  }

  const multiBtn = document.getElementById('btn-multi');
  if (multiBtn) {
    multiBtn.addEventListener('click', () => {
      invoke('open_multi_string_window').catch(console.error);
    });
  }
});
