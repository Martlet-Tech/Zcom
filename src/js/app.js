import { invoke } from '@tauri-apps/api/core';
import { initTitlebar } from './titlebar.js';
import { initMenu } from './menu.js';
import { initReceive, clearReceive, setHexDisplay, setShowTimestamp, applyReceiveStyle } from './receive.js';
import { initBottom } from './bottom.js';
import { initStatusBar } from './statusbar.js';
import { initSettings } from './settings.js';
import { getSettings } from './utils.js';

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

  const multiBtn = document.getElementById('btn-multi');
  if (multiBtn) {
    multiBtn.addEventListener('click', () => {
      invoke('open_multi_string_window').catch(console.error);
    });
  }
});
