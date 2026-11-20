/* Drevanta shared theme binding — one appearance source: Settings → Appearance. */
(() => {
  'use strict';
  const KEY = 'cloudlane-appearance-v110';
  const PALETTES = ['original', 'slate', 'sand', 'sage', 'mauve'];

  function apply() {
    let a = {};
    try { a = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) {}
    const mode = a.mode === 'light' ? 'light' : 'dark';
    const palette = PALETTES.includes(a.palette) ? a.palette : 'original';
    const el = document.documentElement;
    el.dataset.palette = palette;
    el.classList.toggle('dark', mode === 'dark');
    el.style.colorScheme = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#020617' : '#ffffff');
  }

  apply();
  window.addEventListener('storage', (e) => { if (!e.key || e.key === KEY) apply(); });
  window.addEventListener('focus', apply);
  window.DrevantaTheme = { apply };
})();
