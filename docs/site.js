// StreamSnag website: the light and dark switch. Nothing else runs on this site, and nothing is sent
// anywhere. The page follows the system setting until the button is used; the choice is then kept in
// this browser only. Choosing the same theme as the system goes back to following the system.
(function () {
  var root = document.documentElement;
  var KEY = 'streamsnag-theme';
  var system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : '';
    } catch (e) {
      return '';
    }
  }
  function systemTheme() {
    return system && system.matches ? 'dark' : 'light';
  }
  function current() {
    return root.getAttribute('data-theme') || systemTheme();
  }
  function label(buttons) {
    var next = current() === 'dark' ? 'light' : 'dark';
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-label', 'Switch to the ' + next + ' theme');
      buttons[i].setAttribute('title', 'Switch to the ' + next + ' theme');
    }
  }

  // Before the page is drawn, so a stored choice never flashes the other theme.
  var saved = stored();
  if (saved) root.setAttribute('data-theme', saved);
  root.classList.add('js');

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    label(buttons);
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        if (next === systemTheme()) {
          root.removeAttribute('data-theme');
          try { localStorage.removeItem(KEY); } catch (e) { /* private mode: the choice lasts for this page */ }
        } else {
          root.setAttribute('data-theme', next);
          try { localStorage.setItem(KEY, next); } catch (e) { /* as above */ }
        }
        label(buttons);
      });
    }
    if (system && system.addEventListener) system.addEventListener('change', function () { label(buttons); });
  });
})();
