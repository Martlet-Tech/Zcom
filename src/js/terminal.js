import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';
import { TerminalZoom, getZoomLevel } from './zoom.js';

let term = null;
let fitAddon = null;
let termZoom = null;
let baseFontSize = 14;

export function createTerminal(settings) {
  if (term) return;

  baseFontSize = settings.receiveSize || 14;
  term = new Terminal({
    fontSize: Math.max(4, Math.round(baseFontSize * getZoomLevel())),
    fontFamily: settings.receiveFont || 'Consolas',
    theme: {
      background: settings.bgColor || '#0d0d1a',
      foreground: settings.receiveColor || '#00ff00',
      cursor: settings.receiveColor || '#00ff00',
    },
    scrollback: 10000,
    cursorBlink: true,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById('terminal-container');
  container.classList.remove('hidden');
  term.open(container);
  termZoom = new TerminalZoom(container, term, baseFontSize);

  requestAnimationFrame(() => fitAddon.fit());

  term.onData((data) => {
    const bytes = Array.from(new TextEncoder().encode(data));
    invoke('send_raw_bytes', { bytes }).catch(() => {});
  });
}

export function destroyTerminal() {
  termZoom?.destroy();
  termZoom = null;
  if (term) {
    term.dispose();
    term = null;
    fitAddon = null;
  }
  const container = document.getElementById('terminal-container');
  if (container) container.classList.add('hidden');
}

export function termWrite(text) {
  if (term) term.write(text);
}

export function termFit() {
  if (fitAddon) fitAddon.fit();
}

export function clearTerminal() {
  if (term) term.clear();
}

export function updateTerminalTheme(settings) {
  if (term) {
    baseFontSize = settings.receiveSize || 14;
    term.options.theme = {
      background: settings.bgColor || '#0d0d1a',
      foreground: settings.receiveColor || '#00ff00',
      cursor: settings.receiveColor || '#00ff00',
    };
    term.options.fontSize = Math.max(4, Math.round(baseFontSize * getZoomLevel()));
    term.options.fontFamily = settings.receiveFont || 'Consolas';
  }
}
