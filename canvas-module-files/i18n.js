(function (root) {
  'use strict';
  function create(options = {}) {
    const load = options.load || (async file => { const response = await fetch(`locales/${file}`); if (!response.ok) throw new Error(`Language file: ${response.status}`); return response.json(); });
    const packs = new Map(); let language = 'zh-CN', languages = [], reverse = [], base = {};
    async function init(code = 'zh-CN') {
      if (!languages.length) languages = await load('languages.json');
      if (!packs.has('zh-CN')) {
        base = await load(languages.find(l => l.code === 'zh-CN').file); packs.set('zh-CN', base);
        reverse = Object.entries(base).map(([key, value]) => {
          const names = []; const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = escaped.replace(/\\\{(\w+)\\\}/g, (_, name) => { names.push(name); return '(.*?)'; });
          return { key, value, names, pattern: new RegExp(`^${pattern}$`, 's') };
        }).sort((a,b) => a.names.length - b.names.length || b.value.length - a.value.length);
      }
      const target = languages.find(l => l.code === code) || languages.find(l => l.code === 'zh-CN');
      if (!packs.has(target.code)) packs.set(target.code, await load(target.file));
      language = target.code;
    }
    function t(key, values = {}) {
      const text = packs.get(language)?.[key] ?? base[key] ?? key;
      return text.replace(/\{(\w+)\}/g, (whole, name) => values[name] == null ? whole : String(values[name]));
    }
    // Scanner and download engines keep their data independent of the UI locale.
    // Translate their existing diagnostic messages at the presentation boundary.
    function message(text) {
      if (typeof text !== 'string' || language === 'zh-CN') return text;
      for (const entry of reverse) {
        const match = text.match(entry.pattern); if (!match) continue;
        return t(entry.key, Object.fromEntries(entry.names.map((name,i) => [name, match[i+1]])));
      }
      return text;
    }
    function apply(document) {
      document.documentElement.lang = language;
      for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.getAttribute('data-i18n'));
      for (const attribute of ['placeholder', 'aria-label', 'title']) for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
    return { init, t, message, apply, get language() { return language; }, get languages() { return languages; } };
  }
  root.CanvasI18n = create();
  if (typeof module !== 'undefined') module.exports = { create };
})(globalThis);
