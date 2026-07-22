import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getSettings, patchSettings } from './utils.js';

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
      win.hide();
      return;
    }
    if (closeBehavior === 'close') {
      closeAll();
      return;
    }
    const result = await message('关闭主窗口后，多字符串窗口也将关闭。', {
      title: 'Zcom调试助手',
      buttons: { yes: '隐藏到托盘', no: '关闭', cancel: '取消' }
    });
    if (result === '隐藏到托盘') {
      win.hide();
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

  const mcpBtn = document.getElementById('btn-mcp');
  const mcpDot = mcpBtn?.querySelector('.mcp-dot');

  async function updateMcpUI() {
    if (!mcpBtn || !mcpDot) return;
    try {
      const status = await invoke('mcp_get_status');
      if (status.running) {
        mcpDot.className = 'mcp-dot on';
        mcpBtn.title = `MCP 运行中 (端口 ${status.port}) · 点击关闭`;
      } else {
        mcpDot.className = 'mcp-dot';
        mcpBtn.title = 'MCP 已停止 · 点击启用';
      }
    } catch {
      mcpDot.className = 'mcp-dot';
      mcpBtn.title = 'MCP 不可用';
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

  return { getPinned: () => pinned };
}
