import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { parseHexString, getSettings } from './utils.js';

let items = [];
let loopRunning = false;
let loopAbort = false;
let draggedItem = null;

export async function initMulti() {
  const win = getCurrentWindow();

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
      saved.forEach(d => addItem(d.text || '', d.delay || 100, d.hex || false));
      return;
    }
  } catch (e) {
    console.error('load_multi_strings error:', e);
  }
  addItem();
}

async function saveItems() {
  const data = items.map(i => ({ text: i.text, delay: i.delay, hex: i.hex }));
  try {
    await invoke('save_multi_strings', { items: data });
  } catch (e) {
    console.error('save_multi_strings error:', e);
  }
}

function addItem(text, delay, hex) {
  const item = {
    id: Date.now() + Math.random(),
    text: text || '',
    delay: delay !== undefined ? delay : 100,
    hex: hex || false,
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
    <span class="drag-handle">⠿</span>
    <input type="text" class="item-text" value="${escapeHtml(item.text)}" placeholder="输入发送内容" />
    <span class="item-label">延迟:</span>
    <input type="number" class="item-delay" value="${item.delay}" min="0" max="60000" />
    <span class="item-label">ms</span>
    <label class="chk-label">
      <input type="checkbox" class="item-hex-chk" ${item.hex ? 'checked' : ''} /> Hex
    </label>
    <button class="item-send-btn">发送</button>
    <button class="item-del-btn">✕</button>
  `;

  const handle = div.querySelector('.drag-handle');
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startDrag(item, div);
  });

  const textInput = div.querySelector('.item-text');
  textInput.addEventListener('input', () => { item.text = textInput.value; saveItems(); });

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

function startDrag(item, div) {
  if (draggedItem) return;
  draggedItem = item;
  div.classList.add('dragging');

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
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

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

    div.classList.remove('dragging');
    document.querySelectorAll('.multi-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    draggedItem = null;
    renderAll();
    saveItems();
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
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
    if (item.hex) {
      const bytes = parseHexString(item.text);
      await invoke('send_raw_bytes', { bytes });
    } else {
      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(item.text));
      await invoke('send_raw_bytes', { bytes });
    }
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
      const data = items.map(i => ({ text: i.text, delay: i.delay, hex: i.hex }));
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
      data.forEach(d => addItem(d.text || '', d.delay || 100, d.hex || false));
      saveItems();
    }
  } catch (e) {
    console.error('Import error:', e);
  }
}

async function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  loopAbort = false;

  while (loopRunning && !loopAbort) {
    for (const item of items) {
      if (!loopRunning || loopAbort) break;
      if (item.text) {
        await sendItem(item);
        if (item.delay > 0) {
          await new Promise(r => setTimeout(r, item.delay));
        }
      }
    }
    if (items.length === 0) break;
  }

  loopRunning = false;
  const chk = document.getElementById('multi-chk-loop');
  if (chk) chk.checked = false;
}

function stopLoop() {
  loopAbort = true;
  loopRunning = false;
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
