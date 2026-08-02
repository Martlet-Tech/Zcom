export const PortState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  CLOSING: 'closing',
});

export const PortEvent = Object.freeze({
  SELECT: 'select',
  OPEN_START: 'open-start',
  OPEN_OK: 'open-ok',
  OPEN_FAIL: 'open-fail',
  CLOSE_START: 'close-start',
  CLOSED: 'closed',
  DEVICE_LOST: 'device-lost',
  RECONNECTED: 'reconnected',
});

const TABLE = {
  [PortState.DISCONNECTED]: {
    [PortEvent.SELECT]: PortState.DISCONNECTED,
    [PortEvent.OPEN_START]: PortState.CONNECTING,
    [PortEvent.CLOSED]: PortState.DISCONNECTED,
    [PortEvent.RECONNECTED]: PortState.DISCONNECTED,
  },
  [PortState.CONNECTING]: {
    [PortEvent.OPEN_OK]: PortState.CONNECTED,
    [PortEvent.OPEN_FAIL]: PortState.DISCONNECTED,
    [PortEvent.DEVICE_LOST]: PortState.RECONNECTING,
    [PortEvent.RECONNECTED]: PortState.CONNECTED,
  },
  [PortState.CONNECTED]: {
    [PortEvent.CLOSE_START]: PortState.CLOSING,
    [PortEvent.DEVICE_LOST]: PortState.RECONNECTING,
    [PortEvent.CLOSED]: PortState.DISCONNECTED,
    [PortEvent.OPEN_START]: PortState.CONNECTING,
  },
  [PortState.RECONNECTING]: {
    [PortEvent.CLOSE_START]: PortState.CLOSING,
    [PortEvent.RECONNECTED]: PortState.CONNECTED,
    [PortEvent.OPEN_START]: PortState.CONNECTING,
    [PortEvent.DEVICE_LOST]: PortState.RECONNECTING,
    [PortEvent.CLOSED]: PortState.DISCONNECTED,
    [PortEvent.OPEN_OK]: PortState.CONNECTED,
  },
  [PortState.CLOSING]: {
    [PortEvent.CLOSED]: PortState.DISCONNECTED,
    [PortEvent.RECONNECTED]: PortState.CONNECTED,
    [PortEvent.DEVICE_LOST]: PortState.CLOSING,
  },
};

export class PortFSM {
  constructor(initial = PortState.DISCONNECTED) {
    this.state = initial;
    this.portName = null;
    this.baud = null;
    this.listeners = new Set();
  }

  transition(event, { portName, baud } = {}) {
    const next = TABLE[this.state]?.[event];
    if (!next) {
      throw new Error(`Illegal transition: ${this.state} + ${event}`);
    }
    this.state = next;
    if (portName !== undefined) this.portName = portName;
    if (baud !== undefined) this.baud = baud;
    this.listeners.forEach(fn => fn(this.state, this));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get open() {
    return this.state === PortState.CONNECTED;
  }
}

export const portFSM = new PortFSM();
