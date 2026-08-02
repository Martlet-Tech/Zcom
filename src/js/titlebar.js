import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getSettings, patchSettings } from './utils.js';
import { t } from './i18n.js';

let pinned = false;
let currentPortName = null;

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
      win.hide();
      return;
    }
    if (closeBehavior === 'close') {
      closeAll();
      return;
    }
    const result = await message(t('titlebar.closeConfirm'), {
      title: t('app.title'),
      buttons: { yes: t('titlebar.hideToTray'), no: t('common.close'), cancel: t('common.cancel') }
    });
    if (result === t('titlebar.hideToTray')) {
      win.hide();
    } else if (result === t('common.close')) {
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

  const mcpBtn = document.getElementById('btn-mcp');
  const mcpDot = mcpBtn?.querySelector('.mcp-dot');

  async function updateMcpUI() {
    if (!mcpBtn || !mcpDot) return;
    try {
      const status = await invoke('mcp_get_status');
      if (status.running) {
        mcpDot.className = 'mcp-dot on';
        mcpBtn.title = t('titlebar.mcpRunning', { port: status.port });
      } else {
        mcpDot.className = 'mcp-dot';
        mcpBtn.title = t('titlebar.mcpStopped');
      }
    } catch {
      mcpDot.className = 'mcp-dot';
      mcpBtn.title = t('titlebar.mcpUnavailable');
    }
  }

  if (mcpBtn) {
    mcpBtn.addEventListener('click', async () => {
      const { mcpEnabled, mcpPort } = await getSettings();
      const newState = !mcpEnabled;
      await patchSettings({ mcpEnabled: newState });
      if (newState) {
        await invoke('mcp_start', { port: mcpPort }).catch(() => {});
      } else {
        await invoke('mcp_stop').catch(() => {});
      }
      updateMcpUI();
    });
  }

  document.addEventListener('mcp-status-changed', updateMcpUI);
  updateMcpUI();

  document.addEventListener('port-state-change', async (e) => {
    if (e.detail.open) {
      const { currentPort } = await getSettings();
      currentPortName = currentPort;
      invoke('set_window_title', { title: currentPort || t('app.portName') });
    } else {
      currentPortName = null;
      invoke('set_window_title', { title: t('app.title') });
    }
  });

  document.addEventListener('i18n-changed', () => {
    updateMcpUI();
    invoke('set_window_title', { title: currentPortName || t('app.title') });
  });

  return { getPinned: () => pinned };
}
