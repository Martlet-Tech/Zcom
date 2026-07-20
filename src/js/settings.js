import { getSettings, saveSettings } from './utils.js';
import { emit } from '@tauri-apps/api/event';

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
  document.getElementById('setting-font-size').value = ss.fontSize;
  document.getElementById('setting-receive-font').value = ss.receiveFont;
  document.getElementById('setting-receive-size').value = ss.receiveSize;
  document.getElementById('setting-receive-color').value = ss.receiveColor;
  document.getElementById('setting-bg-color').value = ss.bgColor;
  const segTheme = document.querySelector('.segmented[data-setting="theme"]');
  const segLineEnd = document.querySelector('.segmented[data-setting="lineEnding"]');
  const segReceive = document.querySelector('.segmented[data-setting="receiveNewline"]');
  if (segTheme) initSegmented(segTheme, ss.theme);
  if (segLineEnd) initSegmented(segLineEnd, ss.lineEnding);
  if (segReceive) initSegmented(segReceive, ss.receiveNewline);
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

export async function initSettings() {
  const overlay = document.getElementById('settings-overlay');
  const dialog = document.getElementById('settings-dialog');
  const closeBtn = dialog?.querySelector('.dialog-close');
  const closeBtn2 = document.getElementById('setting-close');
  const applyBtn = document.getElementById('setting-apply');
  const fontSize = document.getElementById('setting-font-size');
  const receiveFont = document.getElementById('setting-receive-font');
  const receiveSize = document.getElementById('setting-receive-size');
  const receiveColor = document.getElementById('setting-receive-color');
  const bgColor = document.getElementById('setting-bg-color');

  const segTheme = document.querySelector('.segmented[data-setting="theme"]');
  const segLineEnd = document.querySelector('.segmented[data-setting="lineEnding"]');
  const segReceive = document.querySelector('.segmented[data-setting="receiveNewline"]');

  setupSegmentedListener(segTheme);
  setupSegmentedListener(segLineEnd);
  setupSegmentedListener(segReceive);

  const s = await getSettings();
  applyStyles(s);
  emit('theme-changed', s.theme);
  document.dispatchEvent(new CustomEvent('settings-applied', { detail: s }));
  document.dispatchEvent(new CustomEvent('line-ending-changed', { detail: { lineEnding: s.lineEnding } }));
  document.dispatchEvent(new CustomEvent('receive-newline-changed', { detail: { receiveNewline: s.receiveNewline } }));

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

  async function applySettings() {
    const settings = {
      fontSize: parseInt(fontSize.value) || 14,
      receiveFont: receiveFont.value,
      receiveSize: parseInt(receiveSize.value) || 14,
      receiveColor: receiveColor.value,
      bgColor: bgColor.value,
      theme: segTheme ? readSegmented(segTheme) || 'dark' : 'dark',
      lineEnding: segLineEnd ? readSegmented(segLineEnd) || 'crlf' : 'crlf',
      receiveNewline: segReceive ? readSegmented(segReceive) || 'auto' : 'auto',
    };

    const merged = { ...(await getSettings()), ...settings };
    await saveSettings(merged);
    applyStyles(settings);
    emit('theme-changed', settings.theme);
    document.dispatchEvent(new CustomEvent('settings-applied', { detail: settings }));
    document.dispatchEvent(new CustomEvent('line-ending-changed', { detail: { lineEnding: settings.lineEnding } }));
    document.dispatchEvent(new CustomEvent('receive-newline-changed', { detail: { receiveNewline: settings.receiveNewline } }));
  }

  async function open() {
    await loadDialogValues();
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
  }

  document.addEventListener('open-settings', open);

  closeBtn?.addEventListener('click', close);
  closeBtn2?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  applyBtn.addEventListener('click', async () => {
    await applySettings();
    close();
  });
}
