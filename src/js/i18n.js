import zhCN from '../i18n/zh-CN.json';
import en from '../i18n/en.json';

const locales = { 'zh-CN': zhCN, en };

let currentLang = 'zh-CN';
let messages = zhCN;

function normalizeLang(lang) {
  if (!lang) return 'zh-CN';
  if (lang.startsWith('zh')) return 'zh-CN';
  if (lang.startsWith('en')) return 'en';
  return locales[lang] ? lang : 'zh-CN';
}

export function detectLang() {
  return normalizeLang(navigator.language || 'zh-CN');
}

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  const norm = normalizeLang(lang);
  currentLang = norm;
  messages = locales[norm];
  document.documentElement.lang = norm;
  document.dispatchEvent(new CustomEvent('i18n-changed'));
}

export function t(key, vars) {
  const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), messages);
  if (value == null) return key;
  if (vars) {
    return String(value).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  }
  return String(value);
}

export function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.title = t('app.title');
}
