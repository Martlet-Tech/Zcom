import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { getSettings } from './utils.js';

let pinned = false;

export function initTitlebar() {
  const win = getCurrentWindow();

  async function closeAll() {
    const multi = await WebviewWindow.getByLabel('multi-string');
    if (multi) await multi.close();
    win.close();
  }

  async function handleClose() {
    const { closeBehavior } = await getSettings();
    if (closeBehavior === 'minimize') {
      win.minimize();
      return;
    }
    if (closeBehavior === 'close') {
      closeAll();
      return;
    }
    const result = await message('关闭主窗口后，多字符串窗口也将关闭。', {
      title: 'Zcom调试助手',
      buttons: { yes: '最小化', no: '关闭', cancel: '取消' }
    });
    if (result === '最小化') {
      win.minimize();
    } else if (result === '关闭') {
      closeAll();
    }
  }

  document.getElementById('btn-minimize').addEventListener('click', () => win.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => win.toggleMaximize());
  document.getElementById('btn-close').addEventListener('click', handleClose);

  const pinBtn = document.getElementById('btn-pin');
  pinBtn.style.opacity = '0.5';
  pinBtn.addEventListener('click', async () => {
    pinned = !pinned;
    await win.setAlwaysOnTop(pinned);
    pinBtn.style.color = pinned ? '#00b4d8' : '';
    pinBtn.style.opacity = pinned ? '1' : '0.5';
  });

  return { getPinned: () => pinned };
}
