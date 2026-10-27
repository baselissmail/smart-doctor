// Apply a saved light/dark choice before the first paint (no flash). "auto" follows the OS.
try {
  const t = localStorage.getItem('sd-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage blocked: follow the OS */
}
