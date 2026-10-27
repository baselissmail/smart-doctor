// Progressive enhancement only: every page works without this file.
(() => {
  // ---- theme: auto → dark → light → auto
  const root = document.documentElement;
  const toggle = document.getElementById('theme');
  const names = { auto: 'automatic', dark: 'dark', light: 'light' };
  const current = () => root.dataset.theme || 'auto';
  const show = () => {
    if (!toggle) return;
    toggle.dataset.mode = current();
    toggle.setAttribute('aria-label', `Colour theme: ${names[current()]}. Change`);
    toggle.title = `Theme: ${names[current()]}`;
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

  // ---- mobile menu: close after choosing a link
  for (const menu of document.querySelectorAll('details.menu')) {
    menu.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('a')) menu.removeAttribute('open');
    });
  }

  // ---- copy buttons next to commands
  for (const btn of document.querySelectorAll('button[data-copy]')) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      const code = document.getElementById(btn.dataset.copy || '');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent || '');
        btn.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        btn.textContent = 'Selected';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
  }

  // ---- error catalogue search
  const q = document.getElementById('q');
  if (q instanceof HTMLInputElement) {
    const items = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-search]')]);
    const blocks = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-block]')]);
    const out = document.getElementById('q-count');
    const none = document.getElementById('q-none');
    const box = q.closest('.search');
    if (box instanceof HTMLElement) box.hidden = false;
    const run = () => {
      const terms = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const li of items) {
        const hit = terms.every((t) => (li.dataset.search || '').includes(t));
        li.hidden = !hit;
        if (hit) shown++;
      }
      for (const b of blocks) b.hidden = !b.querySelector('[data-search]:not([hidden])');
      if (out) out.textContent = terms.length ? `${shown} of ${items.length} causes match` : '';
      if (none) none.hidden = shown > 0;
    };
    q.addEventListener('input', run);
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        q.focus();
      }
    });
    if (q.value) run();
  }
})();
