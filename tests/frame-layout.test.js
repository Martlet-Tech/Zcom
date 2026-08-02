import { describe, it, expect } from 'vitest';
import { FrameLayout } from '../src/js/frame-layout.js';

const TS = '[R-12:00:00.000]';

describe('FrameLayout — SSCOM line-breaking rules', () => {
  it('text without timestamp and without newline appends to the same line', () => {
    const l = new FrameLayout();
    expect(l.push('abc')).toEqual([{ type: 'append', text: 'abc' }]);
    expect(l.push('def')).toEqual([{ type: 'append', text: 'def' }]);
    expect(l.open).toBe(true);
  });

  it('text with timestamp starts a new line per chunk', () => {
    const l = new FrameLayout();
    expect(l.push('help', { timestamp: true, ts: TS }))
      .toEqual([{ type: 'line', text: `${TS} help` }]);
    expect(l.push('help', { timestamp: true, ts: TS }))
      .toEqual([{ type: 'line', text: `${TS} help` }]);
    expect(l.open).toBe(false);
  });

  it('hex without timestamp appends with a space separator', () => {
    const l = new FrameLayout();
    expect(l.push('AA BB', { hex: true })).toEqual([{ type: 'append', text: 'AA BB' }]);
    expect(l.push('CC', { hex: true })).toEqual([{ type: 'append', text: ' CC' }]);
    expect(l.open).toBe(true);
  });

  it('text frame ending with newline closes the line (next frame starts fresh)', () => {
    const l = new FrameLayout();
    l.push('help\n');
    expect(l.open).toBe(false);
    expect(l.push('help\n')).toEqual([{ type: 'append', text: 'help' }]);
    expect(l.open).toBe(false);
  });

  it('timestamp + trailing newline emits a blank line after the frame', () => {
    const l = new FrameLayout();
    expect(l.push('help\n', { timestamp: true, ts: TS }))
      .toEqual([
        { type: 'line', text: `${TS} help` },
        { type: 'line', text: '' },
      ]);
    expect(l.open).toBe(false);
  });

  it('splits multi-line text without timestamp', () => {
    const l = new FrameLayout();
    expect(l.push('a\nb')).toEqual([
      { type: 'append', text: 'a' },
      { type: 'line', text: 'b' },
    ]);
    expect(l.open).toBe(true);
    expect(l.push('c')).toEqual([{ type: 'append', text: 'c' }]);
  });

  it('trailing newline after multi-line text keeps the line closed', () => {
    const l = new FrameLayout();
    expect(l.push('a\nb\n')).toEqual([
      { type: 'append', text: 'a' },
      { type: 'line', text: 'b' },
    ]);
    expect(l.open).toBe(false);
  });

  it('double newline produces an empty line', () => {
    const l = new FrameLayout();
    expect(l.push('a\n\nb')).toEqual([
      { type: 'append', text: 'a' },
      { type: 'line', text: '' },
      { type: 'line', text: 'b' },
    ]);
    expect(l.open).toBe(true);
  });

  it('bare newline closes the open line without creating an empty line', () => {
    const l = new FrameLayout();
    l.push('abc');
    expect(l.open).toBe(true);
    expect(l.push('\n')).toEqual([]);
    expect(l.open).toBe(false);
  });

  it('timestamp with internal newlines splits, timestamp only on first part', () => {
    const l = new FrameLayout();
    expect(l.push('a\nb\n', { timestamp: true, ts: TS })).toEqual([
      { type: 'line', text: `${TS} a` },
      { type: 'line', text: 'b' },
      { type: 'line', text: '' },
    ]);
  });
});
