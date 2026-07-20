import { getCurrentWindow } from '@tauri-apps/api/window';

let pinned = false;

export function initTitlebar() {
  const win = getCurrentWindow();

  document.getElementById('btn-minimize').addEventListener('click', () => win.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => win.toggleMaximize());
  document.getElementById('btn-close').addEventListener('click', () => win.close());

  const pinBtn = document.getElementById('btn-pin');
  pinBtn.addEventListener('click', async () => {
    pinned = !pinned;
    await win.setAlwaysOnTop(pinned);
    pinBtn.style.color = pinned ? '#00b4d8' : '';
    pinBtn.style.opacity = pinned ? '1' : '0.5';
  });

  return { getPinned: () => pinned };
}
