// Applies the theme before the page paints, so there is no flash of the wrong colours.
// The visitor's own choice wins; without one, the page follows the system setting.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('spectra-theme');
  } catch (e) {}
  var theme =
    saved === 'light' || saved === 'dark'
      ? saved
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.setAttribute('data-theme', theme);
})();
