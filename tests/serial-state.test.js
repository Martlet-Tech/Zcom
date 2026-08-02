import { describe, it, expect, beforeEach } from 'vitest';
import { PortState, PortEvent, PortFSM } from '../src/js/serial-state.js';

describe('PortFSM transition table', () => {
  let fsm;

  beforeEach(() => {
    fsm = new PortFSM();
  });

  it('starts disconnected and not open', () => {
    expect(fsm.state).toBe(PortState.DISCONNECTED);
    expect(fsm.open).toBe(false);
  });

  it('records portName/baud payload and notifies listeners', () => {
    const seen = [];
    fsm.on((state, f) => seen.push([state, f.portName, f.baud]));
    fsm.transition(PortEvent.SELECT, { portName: 'COM10' });
    fsm.transition(PortEvent.OPEN_START, { portName: 'COM10', baud: 115200 });
    expect(seen).toEqual([
      [PortState.DISCONNECTED, 'COM10', null],
      [PortState.CONNECTING, 'COM10', 115200],
    ]);
  });

  const LEGAL = [
    // [from, event, to]
    [PortState.DISCONNECTED, PortEvent.SELECT, PortState.DISCONNECTED],
    [PortState.DISCONNECTED, PortEvent.OPEN_START, PortState.CONNECTING],
    [PortState.DISCONNECTED, PortEvent.CLOSED, PortState.DISCONNECTED],
    [PortState.DISCONNECTED, PortEvent.RECONNECTED, PortState.DISCONNECTED],
    [PortState.CONNECTING, PortEvent.OPEN_OK, PortState.CONNECTED],
    [PortState.CONNECTING, PortEvent.OPEN_FAIL, PortState.DISCONNECTED],
    [PortState.CONNECTING, PortEvent.DEVICE_LOST, PortState.RECONNECTING],
    [PortState.CONNECTING, PortEvent.RECONNECTED, PortState.CONNECTED],
    [PortState.CONNECTED, PortEvent.CLOSE_START, PortState.CLOSING],
    [PortState.CONNECTED, PortEvent.DEVICE_LOST, PortState.RECONNECTING],
    [PortState.CONNECTED, PortEvent.CLOSED, PortState.DISCONNECTED],
    [PortState.CONNECTED, PortEvent.OPEN_START, PortState.CONNECTING],
    [PortState.RECONNECTING, PortEvent.CLOSE_START, PortState.CLOSING],
    [PortState.RECONNECTING, PortEvent.RECONNECTED, PortState.CONNECTED],
    [PortState.RECONNECTING, PortEvent.OPEN_START, PortState.CONNECTING],
    [PortState.RECONNECTING, PortEvent.DEVICE_LOST, PortState.RECONNECTING],
    [PortState.RECONNECTING, PortEvent.CLOSED, PortState.DISCONNECTED],
    [PortState.RECONNECTING, PortEvent.OPEN_OK, PortState.CONNECTED],
    [PortState.CLOSING, PortEvent.CLOSED, PortState.DISCONNECTED],
    [PortState.CLOSING, PortEvent.RECONNECTED, PortState.CONNECTED],
    [PortState.CLOSING, PortEvent.DEVICE_LOST, PortState.CLOSING],
  ];

  it.each(LEGAL)('allows %s + %s -> %s', (from, event, to) => {
    fsm = new PortFSM(from);
    fsm.transition(event);
    expect(fsm.state).toBe(to);
  });

  it('throws on illegal transitions', () => {
    expect(() => fsm.transition(PortEvent.CLOSED)).not.toThrow(); // disconnected self-loop
    expect(() => fsm.transition(PortEvent.CLOSE_START)).toThrow(); // disconnected has no close
    fsm.transition(PortEvent.OPEN_START);
    expect(() => fsm.transition(PortEvent.CLOSE_START)).toThrow(); // connecting has no close
    fsm.transition(PortEvent.OPEN_OK);
    expect(fsm.open).toBe(true);
    fsm.transition(PortEvent.CLOSE_START);
    expect(() => fsm.transition(PortEvent.OPEN_START)).toThrow(); // closing has no open
  });

  it('models the full happy path', () => {
    fsm.transition(PortEvent.OPEN_START, { portName: 'COM10', baud: 9600 });
    expect(fsm.state).toBe(PortState.CONNECTING);
    fsm.transition(PortEvent.OPEN_OK);
    expect(fsm.state).toBe(PortState.CONNECTED);
    expect(fsm.open).toBe(true);
    fsm.transition(PortEvent.DEVICE_LOST);
    expect(fsm.state).toBe(PortState.RECONNECTING);
    expect(fsm.open).toBe(false);
    fsm.transition(PortEvent.RECONNECTED);
    expect(fsm.state).toBe(PortState.CONNECTED);
    fsm.transition(PortEvent.CLOSE_START);
    fsm.transition(PortEvent.CLOSED);
    expect(fsm.state).toBe(PortState.DISCONNECTED);
  });
});
