import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { timestamp, bytesToHex, getSettings } from './utils.js';
import { termWrite, clearTerminal } from './terminal.js';
import { t } from './i18n.js';
import { ReceiveZoom } from './zoom.js';
import { FrameLayout } from './frame-layout.js';

export let isTerminalMode = false;
export function setTerminalMode(v) { isTerminalMode = v; }

let autoScroll = true;
let hexDisplay = false;
let showTimestamp = true;
let encoding = 'utf-8';
let echoEnabled = true;
let echoPrefix = true;
let receiveContent = null;
let receiveArea = null;
const MAX_FRAMES = 10000;

let filterText = '';
let filterCaseSensitive = false;
let filterRegex = false;
let filterInput = null;

let filterDebounceTimer = null;

let foldEnabled = false;
let foldThreshold = 5;
let foldActive = false;
let foldText = '';
let foldCount = 0;
let foldBadge = null;

let frameRepeat = 0;
let prevFrameRaw = '';

let openFrame = null;
let frameText = '';

let contextMenu = null;

let mcpBuffer = [];
let mcpFlushTimer = null;

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
  return text.replace(/^\[[RT]-?(?:\d{2}:\d{2}:\d{2}\.\d{3})?\]/, '');
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

function buildFrameEl(marker, text) {
  const line = document.createElement('div');
  line.className = 'receive-line frame';
  if (marker) {
    const m = document.createElement('span');
    m.className = 'marker';
    m.textContent = marker;
    line.appendChild(m);
    line.dataset.marker = marker;
  }
  line.appendChild(document.createTextNode(text));
  line.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showLineContextMenu(e, line);
  });
  return line;
}

function createFoldBadge(marker, text, count) {
  const badge = document.createElement('div');
  badge.className = 'receive-line fold-badge';
  if (marker) badge.dataset.marker = marker;
  const textSpan = document.createElement('span');
  textSpan.className = 'fold-text';
  if (marker) {
    const m = document.createElement('span');
    m.className = 'marker';
    m.textContent = marker;
    textSpan.appendChild(m);
  }
  textSpan.appendChild(document.createTextNode(text));
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
  const marker = badge.dataset.marker || null;
  const content = marker ? text.slice(marker.length) : text;
  const match = badge.querySelector('.fold-count').textContent.match(/×(\d+)/);
  if (!match) return;
  const count = parseInt(match[1]);
  for (let i = 0; i < count; i++) {
    const line = buildFrameEl(marker, content);
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
    frameRepeat = 0;
    prevFrameRaw = '';
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
  copyItem.textContent = t('common.copy');
  copyItem.addEventListener('click', () => {
    navigator.clipboard.writeText(badge.dataset.raw || badge.querySelector('.fold-text').textContent);
    dismissContextMenu();
  });
  contextMenu.appendChild(copyItem);
  const foldItem = document.createElement('div');
  foldItem.className = 'context-item';
  foldItem.textContent = t('receive.foldRepeat');
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
  const marker = element.dataset.marker || null;
  const content = marker ? text.slice(marker.length) : text;
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
  const badge = createFoldBadge(marker, content, siblings.length - 1);
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
  copyItem.textContent = t('common.copy');
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
  foldItem.textContent = t('receive.foldRepeat');
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

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(receiveContent);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
}

function evictIfNeeded() {
  while (receiveContent.children.length > MAX_FRAMES) {
    const removed = receiveContent.removeChild(receiveContent.firstChild);
    if (removed === foldBadge) {
      foldActive = false;
      foldBadge = null;
      foldText = '';
      foldCount = 0;
      frameRepeat = 0;
    }
  }
}

const layout = new FrameLayout();

function applyFrameActions(actions) {
  for (const a of actions) {
    if (a.type === 'frame-start') {
      if (!openFrame) {
        openFrame = buildFrameEl(a.marker, '');
        receiveContent.appendChild(openFrame);
        frameText = '';
      }
    } else if (a.type === 'frame-append') {
      if (!openFrame) {
        openFrame = buildFrameEl(null, '');
        receiveContent.appendChild(openFrame);
        frameText = '';
      }
      openFrame.appendChild(document.createTextNode(a.text));
      frameText += a.text;
      if (filterText) {
        openFrame.style.display = matchesFilter(frameText) ? '' : 'none';
      }
    } else if (a.type === 'frame-end') {
      finalizeFrame();
    }
  }
}

/// Closes the current R-frame: fold/filter/mcp/eviction.
function finalizeFrame() {
  if (!openFrame) return;
  const line = openFrame;
  const raw = frameText;
  openFrame = null;
  frameText = '';

  if (foldEnabled) {
    if (foldActive && foldBadge && raw === foldText) {
      foldCount++;
      foldBadge.querySelector('.fold-count').textContent = ` [×${foldCount}]`;
      evictIfNeeded();
      return;
    }
    foldActive = false;
    foldBadge = null;
    foldText = '';
    foldCount = 0;
    frameRepeat = 0;

    if (raw === prevFrameRaw) {
      frameRepeat++;
      if (frameRepeat >= foldThreshold) {
        for (let i = 0; i < frameRepeat - 1; i++) {
          const last = receiveContent.lastElementChild;
          if (last) last.remove();
        }
        const marker = line.dataset.marker || null;
        const badge = createFoldBadge(marker, raw, frameRepeat);
        receiveContent.appendChild(badge);
        for (let i = 0; i < frameRepeat - 1; i++) mcpBuffer.pop();
        mcpBuffer.push(badge.textContent);
        foldActive = true;
        foldText = raw;
        foldCount = frameRepeat;
        foldBadge = badge;
        if (autoScroll) receiveArea.scrollTop = receiveArea.scrollHeight;
        evictIfNeeded();
        return;
      }
    } else {
      frameRepeat = 1;
    }
  }
  prevFrameRaw = raw;

  if (filterText && !matchesFilter(raw)) line.style.display = 'none';
  mcpBuffer.push(raw);
  evictIfNeeded();
  if (autoScroll) receiveArea.scrollTop = receiveArea.scrollHeight;
}

/// One send or terminal keystroke = one echo frame (immediate, no
/// aggregation) — the debug mirror shows exactly what the user produced.
/// Hex display mode applies to echo frames too, so [T]/[R] frames match.
/// `alreadyHex` marks echo content that already is the hex of the actual
/// sent bytes (hex-send / checksum mode) — it must NOT be re-encoded.
function appendEchoFrame(text, marker, alreadyHex = false) {
  if (!echoEnabled) return;
  const display = alreadyHex
    ? text
    : (hexDisplay ? bytesToHex(Array.from(new TextEncoder().encode(text))) : text);
  const line = buildFrameEl(marker, '');
  receiveContent.appendChild(line);
  line.appendChild(document.createTextNode(display));
  if (filterText && !matchesFilter(display)) line.style.display = 'none';
  mcpBuffer.push(display);
  evictIfNeeded();
  if (autoScroll) receiveArea.scrollTop = receiveArea.scrollHeight;
}

export async function appendData({ bytes, frameEnd }, direction) {
  let text;
  try {
    text = await invoke('decode_bytes', { bytes, encoding });
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  }

  // Terminal is the primary data path: always feed it, regardless of mode.
  termWrite(text);

  // Debug view is the mirror: one frame = one div, raw content, long frames
  // are flushed progressively (256B chunks, see FrameLayout).
  // Direction marker is decoupled from the timestamp toggle: [R] / [T]
  // always shown, timestamps append the time when enabled.
  const marker = showTimestamp ? `[${direction}-${timestamp()}]` : '[R]';
  const frameText = hexDisplay ? bytesToHex(bytes) : text;
  applyFrameActions(layout.push(frameText, { frameEnd: !!frameEnd, marker }));
}

function appendSentText(text, isHex) {
  if (!echoEnabled) return;
  const marker = echoPrefix ? (showTimestamp ? `[T-${timestamp()}]` : '[T]') : null;
  appendEchoFrame(text, marker, isHex);
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
  echoEnabled = s.echoEnabled !== false;
  echoPrefix = s.echoPrefix !== false;

  const receiveZoom = new ReceiveZoom(receiveArea, receiveContent);

  receiveArea.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      receiveZoom.setZoom(receiveZoom.getLevel() - e.deltaY * 0.002);
    }
  }, { passive: false });

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
    appendSentText(e.detail.text, e.detail.isHex === true);
  });

  // Cross-window echo from the multi-string window (Tauri event broadcast).
  listen('send-echo', (e) => {
    appendSentText(e.payload.text, e.payload.isHex === true);
  });

  document.addEventListener('terminal-input-echo', (e) => {
    const marker = echoPrefix ? (showTimestamp ? `[T-${timestamp()}]` : '[T]') : null;
    appendEchoFrame(e.detail.text, marker, false);
  });

  document.addEventListener('encoding-change', (e) => {
    encoding = e.detail.encoding;
  });

  document.addEventListener('settings-applied', (e) => {
    echoEnabled = e.detail.echoEnabled !== false;
    echoPrefix = e.detail.echoPrefix !== false;
  });

  document.addEventListener('echo-enabled-change', (e) => {
    echoEnabled = e.detail.on;
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

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (receiveContent && receiveContent.contains(range.commonAncestorContainer)) {
        const bytes = new TextEncoder().encode(sel.toString()).length;
        document.dispatchEvent(new CustomEvent('selection-bytes-changed', { detail: { bytes } }));
        return;
      }
    }
    document.dispatchEvent(new CustomEvent('selection-bytes-changed', { detail: { bytes: null } }));
  });

  mcpFlushTimer = setInterval(flushMcp, 1000);
}

function clearReceiveLines() {
  if (receiveContent) {
    receiveContent.innerHTML = '';
  }
  openFrame = null;
  frameText = '';
  layout.reset();
  foldActive = false;
  foldBadge = null;
  foldText = '';
  foldCount = 0;
  frameRepeat = 0;
  prevFrameRaw = '';
  mcpBuffer = [];
}

export async function clearReceive() {
  await flushMcp();
  clearReceiveLines();
  clearTerminal();
  invoke('mcp_clear_buffer').catch(() => {});
  invoke('reset_io_counters').catch(() => {});
}

async function flushMcp() {
  if (mcpBuffer.length === 0) return;
  const lines = mcpBuffer.splice(0);
  try {
    await invoke('mcp_push_lines', { lines });
  } catch {
    mcpBuffer.unshift(...lines);
    console.warn('MCP flush failed, will retry');
  }
}

export function setHexDisplay(v) {
  hexDisplay = v;
}

export function setShowTimestamp(v) {
  showTimestamp = v;
}

function averageColor(fg, bg) {
  const parse = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  };
  const f = parse(fg);
  const b = parse(bg);
  if (!f || !b) return null;
  return '#' + f.map((v, i) =>
    Math.round((v + b[i]) / 2).toString(16).padStart(2, '0')
  ).join('');
}

export function applyReceiveStyle(settings) {
  if (!receiveArea) return;
  receiveArea.style.fontFamily = settings.receiveFont || 'Consolas';
  receiveArea.style.fontSize = (settings.receiveSize || 14) + 'px';
  receiveArea.style.color = settings.receiveColor || '#00ff00';
  if (settings.bgColor) {
    receiveArea.style.backgroundColor = settings.bgColor;
  }
  const avg = averageColor(settings.receiveColor, settings.bgColor);
  if (avg) receiveArea.style.setProperty('--receive-marker', avg);
}
