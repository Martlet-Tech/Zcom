import { initIcons } from './icons.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { initTitlebar } from './titlebar.js';
import { initMenu, initHelpMenu } from './menu.js';
import { initReceive, clearReceive, setHexDisplay, setShowTimestamp, applyReceiveStyle } from './receive.js';
import { initBottom } from './bottom.js';
import { initStatusBar } from './statusbar.js';
import { initViewMenu } from './view.js';
import { initSettings } from './settings.js';
import { getSettings } from './utils.js';
import { Keybindings } from './keybindings.js';

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
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
  });

  const multiBtn = document.getElementById('btn-multi');
  if (multiBtn) {
    multiBtn.addEventListener('click', () => {
      invoke('open_multi_string_window').catch(console.error);
    });
  }

});
