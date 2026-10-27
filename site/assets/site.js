// Progressive enhancement only: every page works without this file.
(() => {
  // ---- theme: auto → dark → light → auto
  const root = document.documentElement;
  const toggle = document.getElementById('theme');
  const labels = { auto: 'Theme: auto', dark: 'Theme: dark', light: 'Theme: light' };
  const current = () => root.dataset.theme || 'auto';
  const show = () => {
    if (!toggle) return;
    toggle.textContent = labels[current()];
    toggle.setAttribute('aria-label', `Colour theme: ${current()}. Change.`);
  };
  if (toggle) {
    toggle.hidden = false;
    show();
    toggle.addEventListener('click', () => {
      const next = { auto: 'dark', dark: 'light', light: 'auto' }[current()];
      if (next === 'auto') delete root.dataset.theme;
      else root.dataset.theme = next;
      try {
        if (next === 'auto') localStorage.removeItem('sd-theme');
        else localStorage.setItem('sd-theme', next);
      } catch {
        /* not remembered; still applied for this page */
      }
      show();
    });
  }

  // ---- copy buttons next to commands
  for (const btn of document.querySelectorAll('button[data-copy]')) {
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      const code = document.getElementById(btn.dataset.copy);
      const text = code ? code.textContent : '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Selected';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
  }

  // ---- error catalogue search
  const q = document.getElementById('q');
  if (q) {
    const items = [...document.querySelectorAll('[data-search]')];
    const stages = [...document.querySelectorAll('.stage')];
    const out = document.getElementById('q-count');
    const none = document.getElementById('q-none');
    q.closest('.search').hidden = false;
    const run = () => {
      const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const li of items) {
        const hit = terms.every((t) => li.dataset.search.includes(t));
        li.hidden = !hit;
        if (hit) shown++;
      }
      for (const s of stages) s.hidden = !s.querySelector('[data-search]:not([hidden])');
      out.textContent = terms.length ? `${shown} of ${items.length} causes match` : '';
      none.hidden = shown > 0;
    };
    q.addEventListener('input', run);
    if (q.value) run();
  }
})();
