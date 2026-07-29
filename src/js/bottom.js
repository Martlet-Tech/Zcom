// bottom panel logic
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, readFile } from '@tauri-apps/plugin-fs';
import { getSettings, patchSettings } from './utils.js';
import { setButtonIcon, Upload, Square } from './icons.js';

let portOpen = false;
let fileSending = false;
let fileSendAbort = false;
let selectedFilePath = null;
let lineEnding = 'crlf';
let sendNewline = 'raw';

const LINE_ENDING_MAP = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };

function normalizeLineEndings(text, mode) {
  if (mode === 'raw') return text;
  if (mode === 'lf') return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (mode === 'cr') return text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  if (mode === 'crlf') return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  return text;
}

const MIN_SEND_HEIGHT = 32;

export async function initBottom() {
  const fileOpenBtn = document.getElementById('btn-file-open');
  const filePathEl = document.getElementById('file-path');
  const fileSendBtn = document.getElementById('btn-file-send');
  const fileSaveBtn = document.getElementById('btn-file-save');
  const fileStat = document.getElementById('file-stat');
  const clearBtn = document.getElementById('btn-clear-receive');
  const sendBtn = document.getElementById('btn-send');
  const sendText = document.getElementById('send-text');
  const dragHandle = document.getElementById('send-drag-handle');
  const sendArea = document.getElementById('send-area');
  const chkHexSend = document.getElementById('chk-hex-send');
  const chkChecksum = document.getElementById('chk-checksum');
  const checksumType = document.getElementById('checksum-type');
  const checksumPos = document.getElementById('checksum-pos');
  const checksumResult = document.getElementById('checksum-result');
  const checksumByteOrder = document.getElementById('checksum-byte-order');

  const saved = await getSettings();
  lineEnding = saved.lineEnding || 'crlf';
  sendNewline = saved.sendNewline || 'raw';
  sendText.value = saved.sendText || '';
  chkHexSend.checked = saved.hexSend || false;
  chkChecksum.checked = saved.checksumOn || false;
  checksumType.value = saved.checksumType || 'crc16';
  checksumPos.value = saved.checksumPos || '+0';
  checksumType.disabled = !saved.checksumOn;
  checksumPos.disabled = !saved.checksumOn;
  if (saved.checksumLsb) {
    checksumByteOrder.querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b.value === 'lsb'));
  }
  updateByteOrderDisabled();
  if (saved.checksumOn) calcChecksum();

  // restore send area height
  if (saved.sendAreaHeight) {
    sendArea.style.height = saved.sendAreaHeight + 'px';
  }

  // drag to resize send area
  let dragging = false;
  let startY = 0;
  let startH = 0;

  dragHandle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sendArea.offsetHeight;
    dragHandle.classList.add('active');
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.max(MIN_SEND_HEIGHT, startH + (startY - e.clientY));
    sendArea.style.height = h + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dragHandle.classList.remove('active');
    document.body.style.cursor = '';
    const h = sendArea.offsetHeight;
    patchSettings({ sendAreaHeight: h });
  });

  document.addEventListener('port-state-change', (e) => {
    portOpen = e.detail.open;
    sendBtn.disabled = !portOpen;
    fileSendBtn.disabled = !portOpen || !filePathEl.value;
  });

  fileOpenBtn.addEventListener('click', async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: 'All Files', extensions: ['*'] }] });
      if (path) {
        selectedFilePath = path;
        filePathEl.value = path;
        fileSendBtn.disabled = !portOpen;
        fileStat.classList.add('hidden');
      }
    } catch (e) {
      console.error('File open error:', e);
    }
  });

  fileSendBtn.addEventListener('click', async () => {
    if (fileSending) {
      fileSendAbort = true;
      setButtonIcon(fileSendBtn, Square, '中止');
      fileSending = false;
      return;
    }
    const filePath = filePathEl.value.trim();
    if (!filePath || !portOpen) return;

    const { sendChunkInterval, sendChunkSize } = await getSettings();

    fileSending = true;
    fileSendAbort = false;
    selectedFilePath = filePath;
    setButtonIcon(fileSendBtn, Square, '中止');
    fileStat.textContent = '0%';
    fileStat.classList.remove('hidden');

    const startTime = Date.now();
    let total = 0;
    try {
      const content = await readFile(filePath);
      const bytes = new Uint8Array(content);
      total = bytes.length;

      if (sendChunkInterval < 0) {
        const all = Array.from(bytes);
        await invoke('send_raw_bytes', { bytes: all });
        fileStat.textContent = '100%';
      } else {
        for (let i = 0; i < total && !fileSendAbort; i += sendChunkSize) {
          const chunk = Array.from(bytes.slice(i, i + sendChunkSize));
          await invoke('send_raw_bytes', { bytes: chunk });
          const pct = Math.round(Math.min(i + sendChunkSize, total) / total * 100);
          fileStat.textContent = pct + '%';
          if (sendChunkInterval > 0) {
            await new Promise(r => setTimeout(r, sendChunkInterval));
          }
        }
      }
    } catch (e) {
      console.error('File send error:', e);
    }

    fileSending = false;
    const aborted = fileSendAbort;
    fileSendAbort = false;
    setButtonIcon(fileSendBtn, Upload, '发送文件');

    if (!aborted && total > 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const avgSpeed = (total / elapsed / 1024).toFixed(1);
      fileStat.textContent = `用时 ${elapsed.toFixed(2)}s  平均 ${avgSpeed} KB/s`;
    }
  });

  fileSaveBtn.addEventListener('click', async () => {
    try {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const defaultName = `${yy}${mm}${dd}-${hh}${min}${ss}`;
      const path = await save({
        defaultPath: defaultName + '.txt',
        filters: [{ name: 'Text Files', extensions: ['txt', 'log'] }, { name: 'All Files', extensions: ['*'] }]
      });
      if (path) {
        let finalPath = path;
        if (!/\.\w+$/.test(path)) {
          finalPath = path + '.txt';
        }
        await writeTextFile(finalPath, document.getElementById('receive-content')?.textContent || '');
      }
    } catch (e) {
      console.error('File save error:', e);
    }
  });

  clearBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('clear-receive'));
  });

  function getChecksumLsb() {
    return checksumByteOrder.querySelector('.segmented-btn.active')?.value === 'lsb';
  }

  function updateByteOrderDisabled() {
    const disabled = checksumType.value === 'add8' || checksumType.value === 'xor8';
    checksumByteOrder.style.opacity = disabled ? '0.4' : '';
    checksumByteOrder.querySelectorAll('.segmented-btn').forEach(b => {
      b.style.pointerEvents = disabled ? 'none' : '';
    });
  }

  function calcChecksum() {
    const text = sendText.value;
    const hexMode = chkHexSend.checked;
    const algo = checksumType.value;
    const pos = parseInt(checksumPos.value) || 0;
    const lsb = getChecksumLsb();
    if (!text) { checksumResult.textContent = '—'; return; }
    invoke('calculate_checksum', { data: text, hexMode, algo, position: pos, lsb })
      .then(r => { checksumResult.textContent = r.checksum; })
      .catch(() => { checksumResult.textContent = '—'; });
  }

  chkChecksum.addEventListener('change', async () => {
    const on = chkChecksum.checked;
    checksumType.disabled = !on;
    checksumPos.disabled = !on;
    await patchSettings({ checksumOn: on });
    if (on) calcChecksum();
    else checksumResult.textContent = '—';
  });

  checksumType.addEventListener('change', async () => {
    await patchSettings({ checksumType: checksumType.value });
    updateByteOrderDisabled();
    if (chkChecksum.checked) calcChecksum();
  });

  checksumByteOrder.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn || btn.style.pointerEvents === 'none') return;
    checksumByteOrder.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    patchSettings({ checksumLsb: btn.value === 'lsb' });
    if (chkChecksum.checked) calcChecksum();
  });

  checksumPos.addEventListener('input', async () => {
    await patchSettings({ checksumPos: checksumPos.value });
    if (chkChecksum.checked) calcChecksum();
  });

  sendText.addEventListener('input', async () => {
    await patchSettings({ sendText: sendText.value });
    if (chkChecksum.checked) calcChecksum();
  });

  filePathEl.addEventListener('input', () => {
    selectedFilePath = filePathEl.value || null;
    fileSendBtn.disabled = !portOpen || !filePathEl.value;
    fileStat.classList.add('hidden');
  });

  sendText.addEventListener('paste', (e) => {
    if (sendNewline === 'raw') return;
    e.preventDefault();
    const pasted = e.clipboardData.getData('text/plain');
    const normalized = normalizeLineEndings(pasted, sendNewline);
    const start = sendText.selectionStart;
    const end = sendText.selectionEnd;
    const before = sendText.value.substring(0, start);
    const after = sendText.value.substring(end);
    sendText.value = before + normalized + after;
    sendText.selectionStart = sendText.selectionEnd = start + normalized.length;
    sendText.dispatchEvent(new Event('input'));
  });

  document.addEventListener('line-ending-changed', (e) => {
    lineEnding = e.detail.lineEnding;
  });

  document.addEventListener('send-newline-changed', (e) => {
    sendNewline = e.detail.sendNewline;
  });

  sendBtn.addEventListener('click', async () => {
    if (!portOpen) return;
    let text = sendText.value;
    if (!text) return;

    const hexMode = chkHexSend.checked;
    const encoding = document.getElementById('encoding-select')?.value || 'utf-8';

    if (!hexMode) {
      text = normalizeLineEndings(text, sendNewline);
      if (lineEnding !== 'none') {
        text += LINE_ENDING_MAP[lineEnding] || '';
      }
    }

    if (chkChecksum.checked) {
      const algo = checksumType.value;
      const pos = parseInt(checksumPos.value) || 0;
      const lsb = getChecksumLsb();
      try {
        const r = await invoke('calculate_checksum', { data: text, hexMode, algo, position: pos, lsb });
        document.dispatchEvent(new CustomEvent('send-echo', { detail: { text: r.appliedHex } }));
        await invoke('send_data_raw', { data: text, hexMode, encoding, checksumAlgo: algo, checksumPos: pos, checksumLsb: lsb });
      } catch (e) {
        console.error('Checksum error:', e);
      }
    } else {
      document.dispatchEvent(new CustomEvent('send-echo', { detail: { text } }));
      await invoke('send_data_raw', { data: text, hexMode, encoding });
    }
  });

  sendText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.ctrlKey) {
        sendBtn.click();
      } else if (sendNewline !== 'raw') {
        e.preventDefault();
        const nl = LINE_ENDING_MAP[sendNewline] || '\n';
        const start = sendText.selectionStart;
        const end = sendText.selectionEnd;
        const before = sendText.value.substring(0, start);
        const after = sendText.value.substring(end);
        sendText.value = before + nl + after;
        sendText.selectionStart = sendText.selectionEnd = start + nl.length;
        sendText.dispatchEvent(new Event('input'));
      }
    }
  });
}
