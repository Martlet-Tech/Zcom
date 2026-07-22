export class Keybindings {
  constructor() {
    this._blocks = new Set();
    this._handler = null;
    this._ctxHandler = null;
  }

  block(pattern) {
    this._blocks.add(pattern);
    return this;
  }

  unblock(pattern) {
    this._blocks.delete(pattern);
    return this;
  }

  enable() {
    if (this._handler) return this;
    this._handler = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const alt = e.altKey;
      const shift = e.shiftKey;
      const key = e.key;

      let pattern = '';
      if (ctrl) pattern += 'ctrl+';
      if (alt) pattern += 'alt+';
      if (shift) pattern += 'shift+';
      pattern += key.length === 1 ? key.toLowerCase() : key;

      if (this._blocks.has(pattern)) {
        if (key === 'Backspace' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', this._handler);
    return this;
  }

  disable() {
    if (this._handler) {
      document.removeEventListener('keydown', this._handler);
      this._handler = null;
    }
    if (this._ctxHandler) {
      document.removeEventListener('contextmenu', this._ctxHandler);
      this._ctxHandler = null;
    }
    return this;
  }

  blockContextMenu() {
    if (this._ctxHandler) return this;
    this._ctxHandler = (e) => e.preventDefault();
    document.addEventListener('contextmenu', this._ctxHandler);
    return this;
  }

  static defaults() {
    return new Keybindings()
      .block('F5')
      .block('ctrl+r')
      .block('ctrl+shift+r')
      .block('F12')
      .block('ctrl+i')
      .block('ctrl+shift+i')
      .block('ctrl+w')
      .block('ctrl+n')
      .block('ctrl+s')
      .block('ctrl+p')
      .block('Backspace')
      .block('alt+arrowleft')
      .block('alt+arrowright')
      .blockContextMenu();
  }
}
