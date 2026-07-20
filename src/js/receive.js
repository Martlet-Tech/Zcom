import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { timestamp, bytesToHex, getSettings } from './utils.js';

let autoScroll = true;
let hexDisplay = false;
let showTimestamp = true;
let encoding = 'utf-8';
let receiveContent = null;
let receiveArea = null;
let paused = false;

function appendLine(text) {
  if (!receiveContent) return;
  const line = document.createElement('div');
  line.className = 'receive-line';
  line.textContent = text;
  receiveContent.appendChild(line);
  if (autoScroll) {
    receiveArea.scrollTop = receiveArea.scrollHeight;
  }
}

export async function appendData(bytes, direction) {
  let text;
  if (hexDisplay) {
    text = bytesToHex(bytes);
  } else {
    try {
      text = await invoke('decode_bytes', { bytes, encoding });
    } catch {
      text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    }
  }
  if (showTimestamp) text = `[${direction}-${timestamp()}] ${text}`;
  appendLine(text);
}

function appendSentText(text) {
  if (showTimestamp) text = `[T-${timestamp()}] ${text}`;
  appendLine(text);
}

export async function initReceive() {
  receiveContent = document.getElementById('receive-content');
  receiveArea = document.getElementById('receive-area');
  if (!receiveContent || !receiveArea) return;

  const s = await getSettings();
  hexDisplay = s.hexDisplay;
  showTimestamp = s.showTimestamp;
  encoding = s.encoding || 'utf-8';

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
}

export function clearReceive() {
  if (receiveContent) {
    receiveContent.innerHTML = '';
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
