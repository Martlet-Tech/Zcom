import { describe, it, expect } from 'vitest';
import { decodeDisplay } from '../src/js/utils.js';

const enc = (s) => Array.from(new TextEncoder().encode(s));

describe('decodeDisplay — 调试镜像显示形态（前端专用）', () => {
  it('keeps ASCII text as-is', () => {
    expect(decodeDisplay(enc('hello 123'), 'utf-8')).toBe('hello 123');
  });

  it('maps control chars to control pictures', () => {
    expect(decodeDisplay(enc('\x1b[32m'), 'utf-8')).toBe('\u241b[32m');
    expect(decodeDisplay(enc('\r\n'), 'utf-8')).toBe('\u240d\u240a');
    expect(decodeDisplay(enc('\x00'), 'utf-8')).toBe('\u2400');
    expect(decodeDisplay(enc('\x7f'), 'utf-8')).toBe('\u2421');
  });

  it('keeps control chars raw when escapes are off', () => {
    expect(decodeDisplay(enc('\x1b[32m'), 'utf-8', false)).toBe('\x1b[32m');
    expect(decodeDisplay(enc('\r\n'), 'utf-8', false)).toBe('\r\n');
    expect(decodeDisplay(enc('\x00'), 'utf-8', false)).toBe('\x00');
    expect(decodeDisplay(enc('\x7f'), 'utf-8', false)).toBe('\x7f');
  });

  it('decodes valid UTF-8 multibyte sequences', () => {
    expect(decodeDisplay(enc('中文'), 'utf-8')).toBe('中文');
    expect(decodeDisplay(enc('a中b'), 'utf-8')).toBe('a中b');
  });

  it('symbolizes invalid high bytes with CP437', () => {
    expect(decodeDisplay([0x41, 0x80, 0xb3, 0xff], 'utf-8')).toBe('AÇ│\u00a0');
    // invalid continuation after a valid lead is symbolized per byte
    expect(decodeDisplay([0xe4, 0x41], 'utf-8')).toBe('ΣA');
  });

  it('decodes GBK text and symbolizes residual bytes', () => {
    // 中文 in GBK = D6 D0 CE C4; plus a lone high byte with no trail
    expect(decodeDisplay([0xd6, 0xd0, 0xce, 0xc4, 0x80], 'gbk')).toBe('中文Ç');
  });

  it('symbolizes GBK lead without valid trail', () => {
    expect(decodeDisplay([0x81, 0x20], 'gbk')).toBe('ü ');
  });
});
