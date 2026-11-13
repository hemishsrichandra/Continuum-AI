// Runs before first paint so the chosen theme never flashes. Dark is the default; the choice is remembered when storage allows.
(function () {
  var theme = 'dark';
  try { var saved = localStorage.getItem('theme'); if (saved === 'light' || saved === 'dark') theme = saved; } catch (e) { /* storage unavailable: stay dark */ }
  document.documentElement.dataset.theme = theme;
})();
