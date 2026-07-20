import { load } from '@tauri-apps/plugin-store';

let _store;
async function getStore() {
  if (!_store) _store = await load('settings.json');
  return _store;
}

const defaults = {
  fontSize: 14,
  receiveFont: 'Consolas',
  receiveSize: 14,
  receiveColor: '#00ff00',
  bgColor: '#1a1a2e',
  currentPort: '',
  hexDisplay: false,
  showTimestamp: true,
  hexSend: false,
  sendText: '',
  checksumOn: false,
  checksumType: 'crc16',
  checksumPos: '+0',
  encoding: 'utf-8',
  theme: 'dark',
};

export async function getSettings() {
  let s = {};
  try {
    const store = await getStore();
    const raw = await store.get('settings');
    if (raw) s = raw;
  } catch {}
  return { ...defaults, ...s };
}

export async function saveSettings(settings) {
  const store = await getStore();
  await store.set('settings', settings);
  await store.save();
}

export function parseHexString(s) {
  const clean = s.replace(/\s+/g, '');
  if (!clean) return [];
  if (clean.length % 2 !== 0) throw new Error('Hex must have even digits');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function timestamp() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

export function formatByteCount(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
