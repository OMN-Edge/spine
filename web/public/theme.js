// The light or dark look of the page. The choice is "auto" (follow the device), "light" or "dark", kept in this browser only; the
// stylesheet reads it from data-theme on <html>. Loaded in <head> before anything is drawn, so the page never flashes the wrong one.
// src/theme.ts is the app's way to read and change the choice through window.spineTheme.
(function () {
  var KEY = 'spine.theme';
  var root = document.documentElement;
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var held = null; // the choice, when this browser will not let the page store it (it then lasts for this visit)

  function get() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return held || 'auto'; }
  }
  function apply() {
    var choice = get();
    root.setAttribute('data-theme', choice === 'dark' || (choice === 'auto' && query && query.matches) ? 'dark' : 'light');
  }
  function set(choice) {
    held = choice === 'light' || choice === 'dark' ? choice : null;
    try { if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice); else localStorage.removeItem(KEY); } catch (e) { /* held above, for this visit */ }
    apply();
  }

  apply();
  if (query && query.addEventListener) query.addEventListener('change', apply);
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
  window.spineTheme = { get: get, set: set };
})();
