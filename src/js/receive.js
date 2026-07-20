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
let paused = false;
const MAX_LINES = 10000;

let filterText = '';
let filterCaseSensitive = false;
let filterRegex = false;
let filterInput = null;
let filterCount = null;
let filterDebounceTimer = null;

let lineBuffer = '';
let flushTimer = null;
let lastDirection = 'R';
const FLUSH_DELAY = 300;

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

  if (!filterCount) return;
  if (filterText) {
    filterCount.textContent = `${matchCount}/${lines.length}`;
    filterCount.classList.toggle('no-match', matchCount === 0);
  } else {
    filterCount.textContent = '';
    filterCount.classList.remove('no-match');
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

function initFilter() {
  filterInput = document.getElementById('filter-input');
  filterCount = document.getElementById('filter-count');
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
  const line = document.createElement('div');
  line.className = 'receive-line';
  line.textContent = text;
  if (filterText && !matchesFilter(text)) {
    line.style.display = 'none';
  }
  receiveContent.appendChild(line);

  while (receiveContent.children.length > MAX_LINES) {
    receiveContent.removeChild(receiveContent.firstChild);
  }

  if (autoScroll) {
    receiveArea.scrollTop = receiveArea.scrollHeight;
  }
}

function flushBuffer() {
  if (!lineBuffer) return;
  const line = showTimestamp ? `[${lastDirection}-${timestamp()}] ${lineBuffer}` : lineBuffer;
  appendLine(line);
  lineBuffer = '';
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

  lineBuffer += text;

  const parts = lineBuffer.split(/\r\n|\r|\n/);
  for (let i = 0; i < parts.length - 1; i++) {
    const line = showTimestamp ? `[${direction}-${timestamp()}] ${parts[i]}` : parts[i];
    appendLine(line);
  }
  lineBuffer = parts[parts.length - 1];

  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBuffer, FLUSH_DELAY);
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
      paused = true;
      autoScroll = false;
    } else if (atBottom && !autoScroll) {
      paused = false;
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
}

export function setEncoding(enc) {
  encoding = enc;
}

export function clearReceive() {
  lineBuffer = '';
  clearTimeout(flushTimer);
  if (receiveContent) {
    receiveContent.innerHTML = '';
  }
  if (filterCount) {
    filterCount.textContent = '';
    filterCount.classList.remove('no-match');
  }
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
