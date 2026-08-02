import { getSettings, patchSettings } from './utils.js';
import { createElement, Square, CheckSquare } from './icons.js';
import { t } from './i18n.js';

const VIEW_GROUPS = [
  { id: 'filter', key: 'view.filter' },
  { id: 'file', key: 'view.file' },
  { id: 'checksum', key: 'view.checksum' },
];

export async function initViewMenu() {
  const wrap = document.getElementById('view-menu-wrap');
  const btn = document.getElementById('btn-view');
  const dd = document.getElementById('view-dropdown');

  const saved = await getSettings();
  const hiddenGroups = saved.viewHiddenGroups || [];

  function render() {
    dd.innerHTML = '';
    VIEW_GROUPS.forEach(g => {
      const item = document.createElement('div');
      item.className = 'view-item' + (hiddenGroups.includes(g.id) ? '' : ' checked');
      item.dataset.group = g.id;
      item.innerHTML = `<span class="view-check"></span><span>${t(g.key)}</span>`;
      const checkSpan = item.querySelector('.view-check');
      checkSpan.appendChild(createElement(hiddenGroups.includes(g.id) ? Square : CheckSquare));
      item.addEventListener('click', () => toggleGroup(g.id));
      dd.appendChild(item);
    });
  }

  document.addEventListener('i18n-changed', render);

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

  async function saveViewSettings() {
    const partial = { viewHiddenGroups: [...hiddenGroups] };
    await patchSettings(partial);
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

  hiddenGroups.forEach(id => {
    const el = document.querySelector(`[data-view-group="${id}"]`);
    if (el) el.classList.add('view-hidden');
  });
}
