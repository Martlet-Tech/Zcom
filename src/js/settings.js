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
  const themeRadios = document.querySelectorAll('input[name="theme"]');

  const s = await getSettings();
  fontSize.value = s.fontSize;
  receiveFont.value = s.receiveFont;
  receiveSize.value = s.receiveSize;
  receiveColor.value = s.receiveColor;
  bgColor.value = s.bgColor;
  themeRadios.forEach(r => { if (r.value === s.theme) r.checked = true; });
  setThemeClass(s.theme);

  if (systemThemeMedia) {
    systemThemeMedia.removeEventListener('change', systemThemeHandler);
  }
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: light)');
  systemThemeHandler = () => {
    getSettings().then(s => {
      if (s.theme === 'system') setThemeClass('system');
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
    };
    let theme = 'dark';
    themeRadios.forEach(r => { if (r.checked) theme = r.value; });
    settings.theme = theme;

    const merged = { ...(await getSettings()), ...settings };
    await saveSettings(merged);
    document.documentElement.style.fontSize = settings.fontSize + 'px';
    document.documentElement.style.setProperty('--font-size', settings.fontSize + 'px');
    document.documentElement.style.setProperty('--receive-font', settings.receiveFont);
    document.documentElement.style.setProperty('--receive-size', settings.receiveSize + 'px');
    document.documentElement.style.setProperty('--receive-color', settings.receiveColor);
    document.documentElement.style.setProperty('--receive-bg', settings.bgColor);
    setThemeClass(theme);
    emit('theme-changed', theme);
    document.dispatchEvent(new CustomEvent('settings-applied', { detail: settings }));
  }

  function open() {
    loadValues();
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
  }

  async function loadValues() {
    const s = await getSettings();
    fontSize.value = s.fontSize;
    receiveFont.value = s.receiveFont;
    receiveSize.value = s.receiveSize;
    receiveColor.value = s.receiveColor;
    bgColor.value = s.bgColor;
    themeRadios.forEach(r => { if (r.value === s.theme) r.checked = true; });
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

  applySettings();
}
