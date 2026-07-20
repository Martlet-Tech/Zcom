import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile, readFile } from '@tauri-apps/plugin-fs';
import { parseHexString, bytesToHex, getSettings, saveSettings } from './utils.js';

let portOpen = false;
let fileSending = false;
let fileSendAbort = false;
let selectedFilePath = null;
let lineEnding = 'crlf';

const LINE_ENDING_MAP = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };

export async function initBottom() {
  const fileOpenBtn = document.getElementById('btn-file-open');
  const filePathEl = document.getElementById('file-path');
  const fileSendBtn = document.getElementById('btn-file-send');
  const fileSaveBtn = document.getElementById('btn-file-save');
  const clearBtn = document.getElementById('btn-clear-receive');
  const sendBtn = document.getElementById('btn-send');
  const sendText = document.getElementById('send-text');
  const chkHexSend = document.getElementById('chk-hex-send');
  const chkChecksum = document.getElementById('chk-checksum');
  const checksumType = document.getElementById('checksum-type');
  const checksumPos = document.getElementById('checksum-pos');
  const checksumResult = document.getElementById('checksum-result');

  const saved = await getSettings();
  lineEnding = saved.lineEnding || 'crlf';
  sendText.value = saved.sendText || '';
  chkHexSend.checked = saved.hexSend || false;
  chkChecksum.checked = saved.checksumOn || false;
  checksumType.value = saved.checksumType || 'crc16';
  checksumPos.value = saved.checksumPos || '+0';
  checksumType.disabled = !saved.checksumOn;
  checksumPos.disabled = !saved.checksumOn;
  if (saved.checksumOn) calcChecksum();

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
      fileSendBtn.textContent = '📤 发送文件';
      fileSending = false;
      return;
    }
    if (!selectedFilePath || !portOpen) return;

    fileSending = true;
    fileSendAbort = false;
    fileSendBtn.textContent = '⏹ 中止';

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
    fileSendBtn.textContent = '📤 发送文件';
  });

  fileSaveBtn.addEventListener('click', async () => {
    try {
      const path = await save({ filters: [{ name: 'Text Files', extensions: ['txt', 'log'] }, { name: 'All Files', extensions: ['*'] }] });
      if (path) {
        await writeTextFile(path, document.getElementById('receive-content')?.textContent || '');
      }
    } catch (e) {
      console.error('File save error:', e);
    }
  });

  clearBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('clear-receive'));
  });

  function calcChecksum() {
    const text = sendText.value;
    const hexMode = chkHexSend.checked;
    const algo = checksumType.value;
    const pos = parseInt(checksumPos.value) || 0;
    if (!text) { checksumResult.textContent = '—'; return; }
    invoke('calculate_checksum', { data: text, hexMode, algo, position: pos })
      .then(r => { checksumResult.textContent = r.checksum; })
      .catch(() => { checksumResult.textContent = '—'; });
  }

  chkChecksum.addEventListener('change', async () => {
    const on = chkChecksum.checked;
    checksumType.disabled = !on;
    checksumPos.disabled = !on;
    const s = await getSettings();
    s.checksumOn = on;
    await saveSettings(s);
    if (on) calcChecksum();
    else checksumResult.textContent = '—';
  });

  checksumType.addEventListener('change', async () => {
    const s = await getSettings();
    s.checksumType = checksumType.value;
    await saveSettings(s);
    if (chkChecksum.checked) calcChecksum();
  });

  checksumPos.addEventListener('input', async () => {
    const s = await getSettings();
    s.checksumPos = checksumPos.value;
    await saveSettings(s);
    if (chkChecksum.checked) calcChecksum();
  });

  sendText.addEventListener('input', async () => {
    const s = await getSettings();
    s.sendText = sendText.value;
    await saveSettings(s);
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
      try {
        const r = await invoke('calculate_checksum', { data: text, hexMode, algo, position: pos });
        document.dispatchEvent(new CustomEvent('send-echo', { detail: { text: r.appliedHex } }));
        await invoke('send_data_raw', { data: text, hexMode, encoding, checksumAlgo: algo, checksumPos: pos });
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
