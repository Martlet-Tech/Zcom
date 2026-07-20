import { getSettings, saveSettings } from './utils.js';

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

  const s = await getSettings();
  fontSize.value = s.fontSize;
  receiveFont.value = s.receiveFont;
  receiveSize.value = s.receiveSize;
  receiveColor.value = s.receiveColor;
  bgColor.value = s.bgColor;

  async function applySettings() {
    const settings = {
      fontSize: parseInt(fontSize.value) || 14,
      receiveFont: receiveFont.value,
      receiveSize: parseInt(receiveSize.value) || 14,
      receiveColor: receiveColor.value,
      bgColor: bgColor.value,
    };
    const merged = { ...(await getSettings()), ...settings };
    await saveSettings(merged);
    document.documentElement.style.fontSize = settings.fontSize + 'px';
    document.documentElement.style.setProperty('--font-size', settings.fontSize + 'px');
    document.documentElement.style.setProperty('--receive-font', settings.receiveFont);
    document.documentElement.style.setProperty('--receive-size', settings.receiveSize + 'px');
    document.documentElement.style.setProperty('--receive-color', settings.receiveColor);
    document.documentElement.style.setProperty('--receive-bg', settings.bgColor);
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
