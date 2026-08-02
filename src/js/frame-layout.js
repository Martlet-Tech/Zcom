export class FrameLayout {
  constructor() {
    this.open = false;
  }

  push(text, { timestamp = false, hex = false, ts = '' } = {}) {
    const actions = [];

    if (hex) {
      const sep = this.open ? ' ' : '';
      actions.push({ type: 'append', text: sep + text });
      this.open = true;
      return actions;
    }

    const parts = text.split(/\r\n|\r|\n/);
    const trailingNL = /[\r\n]$/.test(text);
    const end = trailingNL ? parts.length - 1 : parts.length;

    if (timestamp) {
      actions.push({ type: 'line', text: ts ? `${ts}${parts[0]}` : parts[0] });
      for (let i = 1; i < end; i++) {
        actions.push({ type: 'line', text: parts[i] });
      }
      if (trailingNL) {
        actions.push({ type: 'line', text: '' });
      }
      this.open = false;
      return actions;
    }

    if (parts[0] !== '') {
      actions.push({ type: 'append', text: parts[0] });
    } else {
      this.open = false;
    }
    for (let i = 1; i < end; i++) {
      actions.push({ type: 'line', text: parts[i] });
    }
    this.open = !trailingNL && end > 0;
    return actions;
  }
}
