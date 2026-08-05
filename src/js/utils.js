import { load } from '@tauri-apps/plugin-store';

let _store;
async function getStore() {
  if (!_store) _store = await load('settings.json');
  return _store;
}

const defaults = {
  language: 'zh-CN',
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
  baudRate: 115200,
  lineEnding: 'crlf',
  sendNewline: 'raw',
  sendChunkInterval: 10,
  sendChunkSize: 1024,
  echoEnabled: true,
  echoPrefix: true,
  mode: 'standard',
  connType: 'serial',
  netRemoteHost: '',
  netRemotePort: '',
  netLocalPort: '',
  espIdfPath: '',
  espPythonPath: '',
  espBaud: 921600,
  foldRepeatCount: 5,
  sendAreaHeight: 80,
  closeBehavior: 'ask',
  charSize: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  mcpEnabled: false,
  mcpPort: 9876,
  autoReconnect: true,
  reconnectInterval: 1000,
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

export async function patchSettings(partial) {
  const s = await getSettings();
  Object.assign(s, partial);
  await saveSettings(s);
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

/// CP437 glyphs for bytes 0x80..=0xFF: every high byte gets a displayable
/// symbol (box drawing, block chars, greek, math) instead of a tofu box.
const CP437 = [
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
  '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
  '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
  '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
  'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
  '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u00a0',
];

function utf8Len(b) {
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

/// Display-form decode for the debug mirror (human eyes only; MCP/backend
/// keep raw decoded text). Walks the raw bytes: ASCII stays as-is, control
/// chars become control pictures (␀..␟, ␡), valid UTF-8/GBK sequences are
/// decoded to text, and bytes that form no valid sequence render as CP437
/// symbols. Pure frontend concern — nothing here feeds the terminal or MCP.
export function decodeDisplay(bytes, encoding) {
  const gbk = encoding === 'gbk';
  const dec = new TextDecoder(gbk ? 'gbk' : 'utf-8');
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let out = '';
  let i = 0;
  while (i < u8.length) {
    const b = u8[i];
    if (b < 0x80) {
      if (b < 0x20) {
        out += String.fromCodePoint(0x2400 + b);
      } else if (b === 0x7f) {
        out += '\u2421';
      } else {
        out += String.fromCharCode(b);
      }
      i += 1;
      continue;
    }
    let seqLen = 0;
    if (gbk) {
      if (b >= 0x81 && b <= 0xfe && i + 1 < u8.length) {
        const t = u8[i + 1];
        if ((t >= 0x40 && t <= 0x7e) || (t >= 0x80 && t <= 0xfe)) seqLen = 2;
      }
    } else {
      seqLen = utf8Len(b);
      if (seqLen > 0 && i + seqLen <= u8.length) {
        for (let k = 1; k < seqLen; k++) {
          const c = u8[i + k];
          if (c < 0x80 || c > 0xbf) { seqLen = 0; break; }
        }
      }
    }
    if (seqLen > 0) {
      const s = dec.decode(u8.subarray(i, i + seqLen));
      if (!s.includes('\uFFFD')) {
        out += s;
        i += seqLen;
        continue;
      }
    }
    out += CP437[b - 0x80];
    i += 1;
  }
  return out;
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
