import { describe, it, expect } from 'vitest';
import { FrameLayout } from '../src/js/frame-layout.js';

const TS = '[R-12:00:00.000]';

describe('FrameLayout — frame model (one frame = one div)', () => {
  it('starts a frame with marker and appends text', () => {
    const l = new FrameLayout();
    expect(l.push('abc', { marker: TS })).toEqual([
      { type: 'frame-start', marker: TS },
    ]);
    expect(l.open).toBe(true);
  });

  it('continues the same frame without frame-end', () => {
    const l = new FrameLayout();
    l.push('abc', { marker: TS });
    expect(l.push('def')).toEqual([]);
    expect(l.open).toBe(true);
  });

  it('flushes pending text on frame-end and closes the frame', () => {
    const l = new FrameLayout();
    l.push('abc', { marker: TS });
    expect(l.push('def', { frameEnd: true })).toEqual([
      { type: 'frame-append', text: 'abcdef' },
      { type: 'frame-end' },
    ]);
    expect(l.open).toBe(false);
  });

  it('an empty frame-end flushes the held text', () => {
    const l = new FrameLayout();
    l.push('abc', { marker: TS });
    expect(l.push('', { frameEnd: true })).toEqual([
      { type: 'frame-append', text: 'abc' },
      { type: 'frame-end' },
    ]);
    expect(l.open).toBe(false);
  });

  it('next frame starts fresh with its own marker', () => {
    const l = new FrameLayout();
    l.push('a', { frameEnd: true, marker: TS });
    expect(l.push('b', { marker: TS })).toEqual([{ type: 'frame-start', marker: TS }]);
    expect(l.open).toBe(true);
  });

  it('long frames flush progressively without waiting for frame-end', () => {
    const l = new FrameLayout(4);
    expect(l.push('abcd', { marker: TS })).toEqual([
      { type: 'frame-start', marker: TS },
      { type: 'frame-append', text: 'abcd' },
    ]);
    expect(l.push('efgh')).toEqual([{ type: 'frame-append', text: 'efgh' }]);
    expect(l.push('ij', { frameEnd: true })).toEqual([
      { type: 'frame-append', text: 'ij' },
      { type: 'frame-end' },
    ]);
    expect(l.open).toBe(false);
  });

  it('partial chunk below the threshold is held until more data arrives', () => {
    const l = new FrameLayout(10);
    l.push('abc', { marker: TS });
    expect(l.push('def')).toEqual([]);
    expect(l.push('ghij', { frameEnd: true })).toEqual([
      { type: 'frame-append', text: 'abcdefghij' },
      { type: 'frame-end' },
    ]);
  });

  it('frame continuation chunks (frameEnd=false) merge into one frame', () => {
    const l = new FrameLayout();
    l.push('aaaa', { marker: TS });
    expect(l.push('bbbb', { frameEnd: false })).toEqual([]);
    expect(l.push('cccc', { frameEnd: true })).toEqual([
      { type: 'frame-append', text: 'aaaabbbbcccc' },
      { type: 'frame-end' },
    ]);
    expect(l.open).toBe(false);
  });

  it('reset abandons an open frame', () => {
    const l = new FrameLayout();
    l.push('abc', { marker: TS });
    l.reset();
    expect(l.open).toBe(false);
    expect(l.push('x', { marker: TS })).toEqual([{ type: 'frame-start', marker: TS }]);
  });
});
