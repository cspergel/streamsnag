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

// ==== Pass 3 (2026-11-11): the menu, and old links into sections that now have pages of their own. Kept in pass3.js beside the site tooling. ====
// Old links. Sections that used to be on the home page now have pages of their own; an address such as
// streamsnag.app/#downloader, which the product and other sites may still use, is sent on to the new page.
// This runs in the head, before anything is drawn. Nothing is sent anywhere.
(function () {
  var MOVED = {
    'evening': 'how-it-works/',
    'stop-save': 'how-it-works/#stop-save',
    'stop-keep': 'how-it-works/#stop-keep',
    'free-line': 'how-it-works/#free-line',
    'stop-read': 'how-it-works/#stop-read',
    'stop-page': 'how-it-works/#stop-page',
    'stop-pack': 'how-it-works/#stop-pack',
    'stop-cards': 'how-it-works/#stop-cards',
    'read': 'how-it-works/#read',
    'downloader': 'downloader/',
    'more-than': 'downloader/#more-than',
    'plans': 'downloader/#plans',
    'ai-cost': 'ai-costs/',
    'contact': 'questions/#contact'
  };
  var canonical = document.querySelector('link[rel="canonical"]');
  var here = document.currentScript && document.currentScript.src;
  // Only on the home page itself (the "not found" page shares its canonical address, and is marked noindex).
  if (!here || !canonical || canonical.getAttribute('href') !== 'https://streamsnag.app/' || document.querySelector('meta[name="robots"]')) return;
  function go() {
    var to = MOVED[decodeURIComponent(location.hash.slice(1))];
    if (to) location.replace(new URL(to, here).href);
  }
  go();
  window.addEventListener('hashchange', go);
})();

// The menu on a phone or tablet is a <details>, so it opens without JavaScript. With it: choosing a link,
// pressing Escape or clicking elsewhere closes it.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var menu = document.querySelector('.menu');
    if (!menu) return;
    menu.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) menu.removeAttribute('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.hasAttribute('open')) {
        menu.removeAttribute('open');
        menu.querySelector('summary').focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (menu.hasAttribute('open') && !menu.contains(e.target)) menu.removeAttribute('open');
    });
  });
})();
