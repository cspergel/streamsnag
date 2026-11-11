// StreamSnag website: the light and dark switch, the menu, old links, and (pass 7) the gentle reveal of the big
// pictures. Nothing is sent anywhere. The page follows the system setting until the button is used; the choice is then kept in
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
// ==== Pass 6 (2026-11-11): old links into the demo. Kept in patch-pass6.py beside the site tooling. ====
// Old links into the demo, which stood at the top of how-it-works/ until pass 6 and now has a page of its own.
// Without JavaScript, how-it-works/#demo lands on the link that leads there.
(function () {
  var canonical = document.querySelector('link[rel="canonical"]');
  var here = document.currentScript && document.currentScript.src;
  if (!here || !canonical || canonical.getAttribute('href') !== 'https://streamsnag.app/how-it-works/') return;
  var MOVED = { 'demo': 'demo/', 'demo-fig': 'demo/#demo-fig', 'demo-title': 'demo/', 'demo-read': 'demo/#demo-read' };
  function go() {
    var to = MOVED[decodeURIComponent(location.hash.slice(1))];
    if (to) location.replace(new URL(to, here).href);
  }
  go();
  window.addEventListener('hashchange', go);
})();
// ==== end of pass 6 ====

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

// ==== Pass 7 (2026-11-11): the big pictures come up gently as they scroll into view. Kept in patch-js-p7.py. ====
// Only with JavaScript and only when the reader has not asked for less motion; without either everything is simply there.
(function () {
  if (!('IntersectionObserver' in window) || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var root = document.documentElement;
  root.classList.add('rv');
  document.addEventListener('DOMContentLoaded', function () {
    var items = document.querySelectorAll('.reveal');
    var seen = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].isIntersecting) {
          entries[i].target.classList.add('is-in');
          seen.unobserve(entries[i].target);
        }
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
    for (var i = 0; i < items.length; i += 1) seen.observe(items[i]);
    // Printing, or a jump to the end: show everything.
    window.addEventListener('beforeprint', function () { root.classList.remove('rv'); });
  });
})();

// The home page's first picture can play a 10-second silent film of the real popup saving the lecture and the
// reading edition opening (img/film/, made from the same screenshots). Only on a wide screen, only when the reader
// has not asked for less motion, only while it is in view, and with a button to pause it. Without JavaScript, or
// before it plays, the still picture underneath is the same scene.
(function () {
  if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  // After the page has loaded and settled, so the film never competes with the first paint.
  window.addEventListener('load', function () { setTimeout(start, 1200); });
  function start() {
    var stage = document.querySelector('[data-film]');
    if (!stage || !window.matchMedia('(min-width: 760px)').matches) return;
    var root = document.documentElement;
    var base = stage.getAttribute('data-film');
    var video = document.createElement('video');
    video.className = 'film';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    video.setAttribute('tabindex', '-1');
    var dark = function () {
      var t = root.getAttribute('data-theme');
      return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    };
    var load = function () {
      var name = base + (dark() ? '-dark' : '');
      video.innerHTML = '';
      [['webm', 'video/webm'], ['mp4', 'video/mp4']].forEach(function (s) {
        var src = document.createElement('source');
        src.src = name + '.' + s[0];
        src.type = s[1];
        video.appendChild(src);
      });
      stage.classList.remove('is-playing');
      video.load();
    };
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'film-btn';
    var paused = false;
    var label = function () {
      button.textContent = paused ? 'Play' : 'Pause';
      button.setAttribute('aria-label', paused ? 'Play the short film of StreamSnag' : 'Pause the short film of StreamSnag');
    };
    label();
    button.addEventListener('click', function () {
      paused = !paused;
      if (paused) video.pause(); else video.play().catch(function () {});
      label();
    });
    video.addEventListener('playing', function () { stage.classList.add('is-playing'); });
    stage.appendChild(video);
    stage.appendChild(button);
    load();
    var inView = false;
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      if (inView && !paused) video.play().catch(function () {}); else video.pause();
    }, { threshold: 0.25 }).observe(stage);
    var again = function () { load(); if (inView && !paused) video.play().catch(function () {}); };
    new MutationObserver(again).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    var system = window.matchMedia('(prefers-color-scheme: dark)');
    if (system.addEventListener) system.addEventListener('change', again);
  }
})();
