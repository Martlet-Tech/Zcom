import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { timestamp, bytesToHex, getSettings } from './utils.js';

let autoScroll = true;
let hexDisplay = false;
let showTimestamp = true;
let encoding = 'utf-8';
let receiveNewline = 'auto';
let receiveContent = null;
let receiveArea = null;
const MAX_LINES = 10000;

let filterText = '';
let filterCaseSensitive = false;
let filterRegex = false;
let filterInput = null;

let filterDebounceTimer = null;

let lastDirection = 'R';

let foldEnabled = false;
let foldThreshold = 5;
let foldActive = false;
let foldText = '';
let foldCount = 0;
let foldBadge = null;

let repeatCount = 0;
let prevRaw = '';

let contextMenu = null;

function matchesFilter(text) {
  if (!filterText) return true;
  let content = text;
  let search = filterText;
  if (!filterCaseSensitive) {
    content = content.toLowerCase();
    search = search.toLowerCase();
  }
  if (filterRegex) {
    try {
      return new RegExp(filterText, filterCaseSensitive ? '' : 'i').test(text);
    } catch {
      return false;
    }
  }
  return content.includes(search);
}

function stripTimestamp(text) {
  return text.replace(/^\[\w-\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '');
}

function applyFilter() {
  filterText = filterInput ? filterInput.value : '';
  if (!receiveContent) return;

  const lines = receiveContent.children;
  let matchCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const matches = matchesFilter(lines[i].textContent);
    lines[i].style.display = matches ? '' : 'none';
    if (matches) matchCount++;
  }

}

function clearFilter() {
  if (filterInput) {
    filterInput.value = '';
    filterInput.blur();
  }
  filterText = '';
  applyFilter();
}

function createFoldBadge(text, count) {
  const badge = document.createElement('div');
  badge.className = 'receive-line fold-badge';
  const textSpan = document.createElement('span');
  textSpan.className = 'fold-text';
  textSpan.textContent = text;
  const countSpan = document.createElement('span');
  countSpan.className = 'fold-count';
  countSpan.textContent = ` [×${count}]`;
  badge.appendChild(textSpan);
  badge.appendChild(countSpan);
  badge.addEventListener('click', () => expandFold(badge));
  badge.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, badge);
  });
  return badge;
}

function expandFold(badge) {
  const text = badge.querySelector('.fold-text').textContent;
  const match = badge.querySelector('.fold-count').textContent.match(/×(\d+)/);
  if (!match) return;
  const count = parseInt(match[1]);
  for (let i = 0; i < count; i++) {
    const line = document.createElement('div');
    line.className = 'receive-line';
    line.textContent = text;
    if (filterText && !matchesFilter(text)) {
      line.style.display = 'none';
    }
    receiveContent.insertBefore(line, badge);
  }
  badge.remove();
  if (foldActive && foldBadge === badge) {
    foldActive = false;
    foldBadge = null;
    foldText = '';
    foldCount = 0;
    repeatCount = 0;
    prevRaw = '';
  }
}

function dismissContextMenu() {
  if (contextMenu) contextMenu.classList.remove('visible');
}

function showContextMenu(e, badge) {
  if (!contextMenu) {
    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    document.body.appendChild(contextMenu);
    document.addEventListener('click', (ev) => {
      if (contextMenu && !contextMenu.contains(ev.target)) {
        dismissContextMenu();
      }
    });
  }
  contextMenu.innerHTML = '';
  const copyItem = document.createElement('div');
  copyItem.className = 'context-item';
  copyItem.textContent = '复制';
  copyItem.addEventListener('click', () => {
    navigator.clipboard.writeText(badge.dataset.raw || badge.querySelector('.fold-text').textContent);
    dismissContextMenu();
  });
  contextMenu.appendChild(copyItem);
  const foldItem = document.createElement('div');
  foldItem.className = 'context-item';
  foldItem.textContent = '折叠以下重复项';
  foldItem.addEventListener('click', () => {
    foldConsecutiveBelow(badge);
    dismissContextMenu();
  });
  contextMenu.appendChild(foldItem);
  contextMenu.style.left = e.clientX + 'px';
  contextMenu.style.top = e.clientY + 'px';
  contextMenu.classList.add('visible');
}

function foldConsecutiveBelow(badge) {
  let next = badge.nextElementSibling;
  const raw = stripTimestamp(badge.querySelector('.fold-text').textContent);
  let hidden = 0;
  while (next) {
    const nextRaw = stripTimestamp(next.textContent);
    if (nextRaw !== raw) break;
    const toRemove = next;
    next = next.nextElementSibling;
    toRemove.remove();
    hidden++;
  }
  if (hidden > 0) {
    const match = badge.querySelector('.fold-count').textContent.match(/×(\d+)/);
    if (match) {
      const current = parseInt(match[1]);
      badge.querySelector('.fold-count').textContent = ` [×${current + hidden}]`;
      if (foldActive && foldBadge === badge) foldCount = current + hidden;
    }
  }
}

function foldFromElement(element) {
  const raw = stripTimestamp(element.textContent);
  const text = element.textContent;
  const siblings = [element];
  let next = element.nextElementSibling;
  while (next) {
    const nextRaw = stripTimestamp(next.textContent);
    if (nextRaw !== raw) break;
    siblings.push(next);
    next = next.nextElementSibling;
  }
  if (siblings.length < 2) return;
  for (const el of siblings) el.remove();
  const badge = createFoldBadge(text, siblings.length - 1);
  if (next && next.parentNode) {
    next.parentNode.insertBefore(badge, next);
  } else {
    receiveContent.appendChild(badge);
  }
  if (foldEnabled) {
    foldActive = true;
    foldText = raw;
    foldCount = siblings.length - 1;
    foldBadge = badge;
  }
}

function showLineContextMenu(e, line) {
  if (!contextMenu) {
    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    document.body.appendChild(contextMenu);
    document.addEventListener('click', (ev) => {
      if (contextMenu && !contextMenu.contains(ev.target)) {
        dismissContextMenu();
      }
    });
  }
  contextMenu.innerHTML = '';
  const copyItem = document.createElement('div');
  copyItem.className = 'context-item';
  copyItem.textContent = '复制';
  copyItem.addEventListener('click', () => {
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    if (selText.length > 0) {
      navigator.clipboard.writeText(selText);
    } else {
      navigator.clipboard.writeText(line.textContent);
    }
    dismissContextMenu();
  });
  contextMenu.appendChild(copyItem);
  const foldItem = document.createElement('div');
  foldItem.className = 'context-item';
  foldItem.textContent = '折叠以下重复项';
  foldItem.addEventListener('click', () => {
    foldFromElement(line);
    dismissContextMenu();
  });
  contextMenu.appendChild(foldItem);
  contextMenu.style.left = e.clientX + 'px';
  contextMenu.style.top = e.clientY + 'px';
  contextMenu.classList.add('visible');
}

function initFilter() {
  filterInput = document.getElementById('filter-input');

  const caseBtn = document.getElementById('filter-btn-case');
  const regexBtn = document.getElementById('filter-btn-regex');
  const clearBtn = document.getElementById('filter-btn-clear');

  if (!filterInput) return;

  filterInput.addEventListener('input', () => {
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(applyFilter, 150);
  });

  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      clearFilter();
    }
  });

  if (caseBtn) {
    caseBtn.addEventListener('click', () => {
      filterCaseSensitive = !filterCaseSensitive;
      caseBtn.classList.toggle('active');
      applyFilter();
    });
  }

  if (regexBtn) {
    regexBtn.addEventListener('click', () => {
      filterRegex = !filterRegex;
      regexBtn.classList.toggle('active');
      applyFilter();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', clearFilter);
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      filterInput.focus();
      filterInput.select();
    }
  });
}

function appendLine(text) {
  if (!receiveContent) return;

  if (foldEnabled) {
    const raw = stripTimestamp(text);

    if (foldActive && foldBadge) {
      if (raw === foldText) {
        foldCount++;
        foldBadge.querySelector('.fold-count').textContent = ` [×${foldCount}]`;
        return;
      }
      foldActive = false;
      foldBadge = null;
      foldText = '';
      foldCount = 0;
      repeatCount = 0;
      prevRaw = '';
    }

    if (raw === prevRaw) {
      repeatCount++;
      if (repeatCount >= foldThreshold) {
        for (let i = 0; i < foldThreshold - 1; i++) {
          const last = receiveContent.lastElementChild;
          if (last) last.remove();
        }
        const badge = createFoldBadge(text, repeatCount);
        receiveContent.appendChild(badge);
        foldActive = true;
        foldText = raw;
        foldCount = repeatCount;
        foldBadge = badge;
        if (autoScroll) receiveArea.scrollTop = receiveArea.scrollHeight;
        return;
      }
    } else {
      repeatCount = 1;
      prevRaw = raw;
    }
  }

  const line = document.createElement('div');
  line.className = 'receive-line';
  line.textContent = text;
  if (filterText && !matchesFilter(text)) {
    line.style.display = 'none';
  }
  line.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showLineContextMenu(e, line);
  });
  receiveContent.appendChild(line);

  while (receiveContent.children.length > MAX_LINES) {
    const removed = receiveContent.removeChild(receiveContent.firstChild);
    if (removed === foldBadge) {
      foldActive = false;
      foldBadge = null;
      foldText = '';
      foldCount = 0;
      repeatCount = 0;
      prevRaw = '';
    }
  }

  if (autoScroll) {
    receiveArea.scrollTop = receiveArea.scrollHeight;
  }
}

function appendChunkLine(text) {
  if (showTimestamp) text = `[${lastDirection}-${timestamp()}] ${text}`;
  appendLine(text);
}

function appendStreamText(text) {
  if (!receiveContent) return;
  const last = receiveContent.lastElementChild;
  if (!last) {
    appendChunkLine(text);
    return;
  }
  last.textContent += text;
  if (filterText) {
    last.style.display = matchesFilter(last.textContent) ? '' : 'none';
  }
  if (autoScroll) {
    receiveArea.scrollTop = receiveArea.scrollHeight;
  }
}

export async function appendData(bytes, direction) {
  lastDirection = direction;

  if (hexDisplay) {
    appendChunkLine(bytesToHex(bytes));
    return;
  }

  let text;
  try {
    text = await invoke('decode_bytes', { bytes, encoding });
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  }

  if (receiveNewline === 'chunks') {
    appendChunkLine(text);
    return;
  }

  if (receiveNewline === 'stream') {
    appendStreamText(text);
    return;
  }

  const parts = text.split(/\r\n|\r|\n/);
  const count = /[\r\n]$/.test(text) ? parts.length - 1 : parts.length;
  for (let i = 0; i < count; i++) {
    const line = showTimestamp ? `[${direction}-${timestamp()}] ${parts[i]}` : parts[i];
    appendLine(line);
  }
}

function appendSentText(text) {
  if (showTimestamp) text = `[T-${timestamp()}] ${text}`;
  appendLine(text);
}

export async function initReceive() {
  receiveContent = document.getElementById('receive-content');
  receiveArea = document.getElementById('receive-area');
  if (!receiveContent || !receiveArea) return;

  initFilter();

  const s = await getSettings();
  hexDisplay = s.hexDisplay;
  showTimestamp = s.showTimestamp;
  encoding = s.encoding || 'utf-8';
  receiveNewline = s.receiveNewline || 'auto';

  document.addEventListener('receive-newline-changed', (e) => {
    receiveNewline = e.detail.receiveNewline;
  });

  receiveArea.addEventListener('scroll', () => {
    const el = receiveArea;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (!atBottom && autoScroll) {
      autoScroll = false;
    } else if (atBottom && !autoScroll) {
      autoScroll = true;
    }
  });

  listen('serial-data', async (event) => {
    await appendData(event.payload, 'R');
  });

  document.addEventListener('send-echo', (e) => {
    appendSentText(e.detail.text);
  });

  document.addEventListener('encoding-change', (e) => {
    encoding = e.detail.encoding;
  });

  foldEnabled = document.getElementById('chk-fold-repeat').checked;
  foldThreshold = s.foldRepeatCount || 5;

  document.getElementById('chk-fold-repeat').addEventListener('change', (e) => {
    foldEnabled = e.target.checked;
    if (!foldEnabled && foldActive) {
      if (foldBadge) expandFold(foldBadge);
    }
  });

  document.addEventListener('fold-repeat-changed', (e) => {
    foldThreshold = e.detail.foldRepeatCount || 5;
  });
}

export function setEncoding(enc) {
  encoding = enc;
}

export function clearReceive() {
  if (receiveContent) {
    receiveContent.innerHTML = '';
  }
  foldActive = false;
  foldBadge = null;
  foldText = '';
  foldCount = 0;
  repeatCount = 0;
  prevRaw = '';
}

export function getReceiveText() {
  return receiveContent ? receiveContent.textContent || '' : '';
}

export function setHexDisplay(v) {
  hexDisplay = v;
}

export function setShowTimestamp(v) {
  showTimestamp = v;
}

export function applyReceiveStyle(settings) {
  if (!receiveArea) return;
  receiveArea.style.fontFamily = settings.receiveFont || 'Consolas';
  receiveArea.style.fontSize = (settings.receiveSize || 14) + 'px';
  receiveArea.style.color = settings.receiveColor || '#00ff00';
  if (settings.bgColor) {
    receiveArea.style.backgroundColor = settings.bgColor;
  }
}
