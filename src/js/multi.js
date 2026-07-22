import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { parseHexString, getSettings } from './utils.js';
import { initIcons, createElement, GripVertical, X } from './icons.js';
import { Keybindings } from './keybindings.js';

let items = [];
let loopActive = false;
let loopAbort = false;
let draggedItem = null;

export async function initMulti() {
  const win = getCurrentWindow();
  Keybindings.defaults().enable();
  initIcons();

  const s = await getSettings();
  applyThemeClass(s.theme || 'dark');
  if (s.theme === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', () => applyThemeClass('system'));
  }
  listen('theme-changed', (e) => applyThemeClass(e.payload));

  document.getElementById('multi-btn-minimize')?.addEventListener('click', () => win.minimize());
  document.getElementById('multi-btn-close')?.addEventListener('click', () => win.close());

  const pinBtn = document.getElementById('multi-btn-pin');
  let pinned = false;
  pinBtn.style.opacity = '0.5';
  pinBtn.addEventListener('click', async () => {
    pinned = !pinned;
    await win.setAlwaysOnTop(pinned);
    pinBtn.style.color = pinned ? '#00b4d8' : '';
    pinBtn.style.opacity = pinned ? '1' : '0.5';
  });

  document.getElementById('multi-btn-add').addEventListener('click', () => { addItem(); saveItems(); });
  document.getElementById('multi-btn-del-all').addEventListener('click', () => { deleteAll(); saveItems(); });
  document.getElementById('multi-btn-export').addEventListener('click', exportJson);
  document.getElementById('multi-btn-import').addEventListener('click', importJson);

  const loopChk = document.getElementById('multi-chk-loop');
  loopChk.addEventListener('change', () => {
    if (loopChk.checked) {
      startLoop();
    } else {
      stopLoop();
    }
  });

  try {
    const saved = await invoke('load_multi_strings');
    if (saved && saved.length > 0) {
      saved.forEach(d => addItem(d.text, d.delay, d.hex === true, d.name));
    } else {
      addItem();
    }
  } catch (e) {
    console.error('load_multi_strings error:', e);
    addItem();
  }

  await win.show();
  await win.setFocus();
}

async function saveItems() {
  const data = items.map(i => ({ text: i.text, delay: i.delay, hex: i.hex, name: i.name }));
  try {
    await invoke('save_multi_strings', { items: data });
  } catch (e) {
    console.error('save_multi_strings error:', e);
  }
}

function addItem(text, delay, hex, name) {
  const item = {
    id: Date.now() + Math.random(),
    text: String(text || ''),
    delay: Math.min(60000, Math.max(0, parseInt(delay, 10) || 100)),
    hex: hex === true,
    name: String(name || ''),
  };
  items.push(item);
  renderItem(item);
}

function renderItem(item) {
  const list = document.getElementById('multi-list');
  const div = document.createElement('div');
  div.className = 'multi-item';
  div.dataset.id = item.id;
  div.innerHTML = `
    <span class="drag-handle"></span>
    <button class="item-del-btn"></button>
    <div class="item-text-wrap" data-item-id="${item.id}">
      <span class="item-text-data">${escapeHtml(item.text || ' ')}</span>
      <span class="item-text-name${item.name ? '' : ' placeholder'}">${escapeHtml(item.name || '点击命名')}</span>
      <input type="text" class="item-text-input" placeholder="输入发送内容" />
      <input type="text" class="item-text-name-input" placeholder="输入备注名称..." />
    </div>
    <span class="item-label">延迟:</span>
    <input type="number" class="item-delay" value="${item.delay}" min="0" max="60000" />
    <span class="item-label">ms</span>
    <label class="chk-label">
      <input type="checkbox" class="item-hex-chk" ${item.hex ? 'checked' : ''} /> Hex
    </label>
    <button class="item-send-btn">发送</button>
  `;

  const handle = div.querySelector('.drag-handle');
  handle.appendChild(createElement(GripVertical));
  div.querySelector('.item-del-btn').appendChild(createElement(X));

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startDrag(item, div);
  });

  const wrap = div.querySelector('.item-text-wrap');
  const dataSpan = wrap.querySelector('.item-text-data');
  const nameSpan = wrap.querySelector('.item-text-name');
  const dataInput = wrap.querySelector('.item-text-input');
  const nameInput = wrap.querySelector('.item-text-name-input');

  dataSpan.addEventListener('click', () => {
    dataInput.value = item.text;
    wrap.classList.add('edit-data');
    dataInput.focus();
    dataInput.select();
  });

  nameSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    nameInput.value = item.name;
    wrap.classList.add('edit-name');
    nameInput.focus();
    nameInput.select();
  });

  dataInput.addEventListener('blur', () => saveDataEdit(item, dataSpan, dataInput, wrap));
  dataInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dataInput.blur(); }
  });

  nameInput.addEventListener('blur', () => saveNameEdit(item, nameSpan, nameInput, wrap));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
  });

  const delayInput = div.querySelector('.item-delay');
  delayInput.addEventListener('input', () => { item.delay = parseInt(delayInput.value) || 0; saveItems(); });

  const hexChk = div.querySelector('.item-hex-chk');
  hexChk.addEventListener('change', () => { item.hex = hexChk.checked; saveItems(); });

  div.querySelector('.item-send-btn').addEventListener('click', () => sendItem(item));
  div.querySelector('.item-del-btn').addEventListener('click', () => {
    const idx = items.findIndex(i => i.id === item.id);
    if (idx >= 0) items.splice(idx, 1);
    div.remove();
    saveItems();
  });

  list.appendChild(div);
}

function saveDataEdit(item, dataSpan, dataInput, wrap) {
  item.text = dataInput.value;
  dataSpan.textContent = item.text || ' ';
  wrap.classList.remove('edit-data');
  saveItems();
}

function saveNameEdit(item, nameSpan, nameInput, wrap) {
  item.name = nameInput.value;
  nameSpan.textContent = item.name || '点击命名';
  nameSpan.classList.toggle('placeholder', !item.name);
  wrap.classList.remove('edit-name');
  saveItems();
}

function startDrag(item, div) {
  if (draggedItem) return;
  draggedItem = item;
  div.classList.add('dragging');

  function cleanup() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('blur', cleanup);
    div.classList.remove('dragging');
    document.querySelectorAll('.multi-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    if (draggedItem) {
      draggedItem = null;
      renderAll();
      saveItems();
    }
  }

  function onMouseMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const targetDiv = el.closest('.multi-item');
    document.querySelectorAll('.multi-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    if (targetDiv && targetDiv !== div) {
      targetDiv.classList.add('drag-over');
    }
  }

  function onMouseUp(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetDiv = el?.closest('.multi-item');
    if (targetDiv && targetDiv !== div) {
      const targetItem = items.find(i => i.id.toString() === targetDiv.dataset.id);
      if (targetItem) {
        const fromIdx = items.findIndex(i => i.id === item.id);
        const toIdx = items.findIndex(i => i.id === targetItem.id);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [removed] = items.splice(fromIdx, 1);
          items.splice(toIdx, 0, removed);
        }
      }
    }
    cleanup();
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', cleanup);
}

function renderAll() {
  const list = document.getElementById('multi-list');
  list.innerHTML = '';
  items.forEach(item => renderItem(item));
}

function deleteAll() {
  items = [];
  document.getElementById('multi-list').innerHTML = '';
}

async function sendItem(item) {
  if (!item.text) return;
  try {
    const s = await getSettings();
    const encoding = s.encoding || 'utf-8';
    await invoke('send_data_raw', { data: item.text, hexMode: item.hex, encoding });
  } catch (e) {
    console.error('Multi send error:', e);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function exportJson() {
  try {
    const path = await save({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (path) {
      const data = items.map(i => ({ text: i.text, delay: i.delay, hex: i.hex, name: i.name }));
      await writeTextFile(path, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    console.error('Export error:', e);
  }
}

async function importJson() {
  try {
    const path = await open({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (path) {
      const content = await readTextFile(path);
      const data = JSON.parse(content);
      if (!Array.isArray(data)) return;
      items = [];
      document.getElementById('multi-list').innerHTML = '';
      data.forEach(d => addItem(d.text, d.delay, d.hex === true, d.name));
      saveItems();
    }
  } catch (e) {
    console.error('Import error:', e);
  }
}

async function startLoop() {
  if (loopActive) return;
  loopActive = true;
  loopAbort = false;

  while (loopActive && !loopAbort) {
    for (const item of items) {
      if (!loopActive || loopAbort) break;
      if (item.text) {
        await sendItem(item);
        if (item.delay > 0) {
          await new Promise(r => setTimeout(r, item.delay));
        }
      }
    }
    if (items.length === 0) break;
  }

  loopActive = false;
  const chk = document.getElementById('multi-chk-loop');
  if (chk) chk.checked = false;
}

function stopLoop() {
  loopAbort = true;
  loopActive = false;
}

function applyThemeClass(theme) {
  const html = document.documentElement;
  if (theme === 'system') {
    const light = window.matchMedia('(prefers-color-scheme: light)').matches;
    html.className = light ? 'theme-light' : '';
  } else {
    html.className = theme === 'dark' ? '' : `theme-${theme}`;
  }
}

initMulti();
