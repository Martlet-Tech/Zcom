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

const LINE_ENDING_MAP = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };

const MIN_SEND_HEIGHT = 32;

export async function initBottom() {
  const fileOpenBtn = document.getElementById('btn-file-open');
  const filePathEl = document.getElementById('file-path');
  const fileSendBtn = document.getElementById('btn-file-send');
  const fileSaveBtn = document.getElementById('btn-file-save');
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
    fileSendBtn.disabled = !portOpen || !selectedFilePath;
  });

  fileOpenBtn.addEventListener('click', async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: 'All Files', extensions: ['*'] }] });
      if (path) {
        selectedFilePath = path;
        filePathEl.textContent = path;
        fileSendBtn.disabled = !portOpen;
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
    if (!selectedFilePath || !portOpen) return;

    fileSending = true;
    fileSendAbort = false;
    setButtonIcon(fileSendBtn, Square, '中止');

    try {
      const content = await readFile(selectedFilePath);
      const bytes = new Uint8Array(content);
      const chunkSize = 1024;
      for (let i = 0; i < bytes.length && !fileSendAbort; i += chunkSize) {
        const chunk = Array.from(bytes.slice(i, i + chunkSize));
        await invoke('send_raw_bytes', { bytes: chunk });
        await new Promise(r => setTimeout(r, 10));
      }
    } catch (e) {
      console.error('File send error:', e);
    }

    fileSending = false;
    fileSendAbort = false;
    setButtonIcon(fileSendBtn, Upload, '发送文件');
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

  document.addEventListener('line-ending-changed', (e) => {
    lineEnding = e.detail.lineEnding;
  });

  sendBtn.addEventListener('click', async () => {
    if (!portOpen) return;
    let text = sendText.value;
    if (!text) return;

    const hexMode = chkHexSend.checked;
    const encoding = document.getElementById('encoding-select')?.value || 'utf-8';

    if (!hexMode && lineEnding !== 'none') {
      text += LINE_ENDING_MAP[lineEnding] || '';
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
    if (e.key === 'Enter' && e.ctrlKey) {
      sendBtn.click();
    }
  });
}
