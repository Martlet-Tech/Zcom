import { getSettings, saveSettings } from './utils.js';

const VIEW_GROUPS = [
  { id: 'filter', label: '过滤栏' },
  { id: 'file', label: '文件操作' },
  { id: 'checksum', label: '附加校验' },
];

let currentMode = 'multi';

export async function initViewMenu() {
  const wrap = document.getElementById('view-menu-wrap');
  const btn = document.getElementById('btn-view');
  const dd = document.getElementById('view-dropdown');

  const saved = await getSettings();
  const hiddenGroups = saved.viewHiddenGroups || [];
  currentMode = saved.sendMode || 'multi';

  function render() {
    dd.innerHTML = '';

    VIEW_GROUPS.forEach(g => {
      const item = document.createElement('div');
      item.className = 'view-item' + (hiddenGroups.includes(g.id) ? '' : ' checked');
      item.dataset.group = g.id;
      item.innerHTML = `<span class="view-check">${hiddenGroups.includes(g.id) ? '☐' : '☑'}</span><span>${g.label}</span>`;
      item.addEventListener('click', () => toggleGroup(g.id));
      dd.appendChild(item);
    });

    const divider = document.createElement('div');
    divider.className = 'view-divider';
    dd.appendChild(divider);

    const modes = [
      { value: 'multi', label: '发送区(多行)' },
      { value: 'compact', label: '发送区(单行)' },
    ];
    modes.forEach(m => {
      const item = document.createElement('div');
      item.className = 'view-item' + (currentMode === m.value ? ' active-mode' : '');
      item.dataset.mode = m.value;
      item.innerHTML = `<span class="view-check">${currentMode === m.value ? '●' : '○'}</span><span>${m.label}</span>`;
      item.addEventListener('click', () => setMode(m.value));
      dd.appendChild(item);
    });
  }

  function toggleGroup(id) {
    const idx = hiddenGroups.indexOf(id);
    if (idx >= 0) {
      hiddenGroups.splice(idx, 1);
    } else {
      hiddenGroups.push(id);
    }
    const el = document.querySelector(`[data-view-group="${id}"]`);
    if (el) el.classList.toggle('view-hidden');
    render();
    saveViewSettings();
  }

  function setMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    const sendArea = document.getElementById('send-area');
    const textarea = document.getElementById('send-text');
    const sendBtn = document.getElementById('btn-send');
    if (mode === 'compact') {
      sendArea.classList.add('send-mode-compact');
      textarea.rows = 1;
    } else {
      sendArea.classList.remove('send-mode-compact');
      textarea.rows = 4;
    }
    render();
    saveViewSettings();
    document.dispatchEvent(new CustomEvent('send-mode-change', { detail: { mode } }));
  }

  async function saveViewSettings() {
    const s = await getSettings();
    s.viewHiddenGroups = hiddenGroups;
    s.sendMode = currentMode;
    await saveSettings(s);
  }

  render();

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('open');
    }
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });

  // apply saved state on init
  hiddenGroups.forEach(id => {
    const el = document.querySelector(`[data-view-group="${id}"]`);
    if (el) el.classList.add('view-hidden');
  });
  if (currentMode === 'compact') {
    const sendArea = document.getElementById('send-area');
    const textarea = document.getElementById('send-text');
    if (sendArea) sendArea.classList.add('send-mode-compact');
    if (textarea) textarea.rows = 1;
    document.dispatchEvent(new CustomEvent('send-mode-change', { detail: { mode: currentMode } }));
  }
}

export function getSendMode() {
  return currentMode;
}
