import { t } from './i18n.js';

let sharedLevel = 1.0;
const instances = new Set();

export function getZoomLevel() {
  return sharedLevel;
}

export class Zoomable {
  constructor(container, base = 1) {
    this.container = container;
    this.base = base;
    instances.add(this);
    this.buildBar();
    this.bindWheel();
    document.addEventListener('i18n-changed', this.onI18nChanged);
  }

  onI18nChanged = () => {
    const btnReset = this.bar?.querySelector('.zoom-bar-reset');
    if (btnReset) btnReset.textContent = t('common.reset');
  };

  setZoom(v) {
    sharedLevel = Math.max(0.3, Math.min(5, v));
    instances.forEach(inst => {
      inst.applyZoom(sharedLevel);
      inst.updateBar();
    });
  }

  getLevel() {
    return sharedLevel;
  }

  applyZoom(level) {}

  buildBar() {
    this.bar = document.createElement('div');
    this.bar.id = 'zoom-bar';
    this.bar.className = 'hidden';

    const btnIn = document.createElement('button');
    btnIn.className = 'zoom-bar-btn';
    btnIn.textContent = '+';
    btnIn.addEventListener('click', () => this.setZoom(sharedLevel + 0.1));

    const sep1 = document.createElement('span');
    sep1.className = 'zoom-bar-sep';
    sep1.textContent = '|';

    this.label = document.createElement('span');
    this.label.className = 'zoom-bar-label';

    const btnReset = document.createElement('button');
    btnReset.className = 'zoom-bar-reset';
    btnReset.textContent = t('common.reset');
    btnReset.addEventListener('click', () => this.setZoom(1));

    const sep2 = document.createElement('span');
    sep2.className = 'zoom-bar-sep';
    sep2.textContent = '|';

    const btnOut = document.createElement('button');
    btnOut.className = 'zoom-bar-btn';
    btnOut.textContent = '\u2212';
    btnOut.addEventListener('click', () => this.setZoom(sharedLevel - 0.1));

    this.bar.appendChild(btnIn);
    this.bar.appendChild(sep1);
    this.bar.appendChild(this.label);
    this.bar.appendChild(btnReset);
    this.bar.appendChild(sep2);
    this.bar.appendChild(btnOut);
    this.container.appendChild(this.bar);

    this.updateBar();
  }

  updateBar() {
    if (!this.bar) return;
    this.label.textContent = Math.round(sharedLevel * 100) + '%';
    this.bar.classList.toggle('hidden', sharedLevel === 1);
  }

  bindWheel() {
    this.onWheel = (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.setZoom(sharedLevel - e.deltaY * 0.002);
      }
    };
    this.container.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy() {
    this.container.removeEventListener('wheel', this.onWheel, { passive: false });
    document.removeEventListener('i18n-changed', this.onI18nChanged);
    this.bar?.remove();
    this.bar = null;
    instances.delete(this);
  }
}

export class ReceiveZoom extends Zoomable {
  constructor(container, content) {
    super(container);
    this.content = content;
  }

  applyZoom(level) {
    this.content.style.zoom = level;
  }
}

export class TerminalZoom extends Zoomable {
  constructor(container, term, baseSize) {
    super(container, baseSize);
    this.term = term;
  }

  applyZoom(level) {
    if (this.term) this.term.options.fontSize = Math.max(4, Math.round(this.base * level));
  }
}
