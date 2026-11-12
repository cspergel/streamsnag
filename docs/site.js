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
      // The phone menu's item says what it switches to ("Dark theme", "Light theme"); the header's icon is labelled.
      if (buttons[i].hasAttribute('data-theme-name')) {
        buttons[i].textContent = next === 'dark' ? 'Dark theme' : 'Light theme';
        continue;
      }
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
    // The button goes on the caption's line under the picture, never floating beside it.
    var caption = stage.parentNode && stage.parentNode.querySelector('figcaption');
    (caption || stage).appendChild(button);
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

// ==== Pass 8 (2026-11-11): the green band's "what was said, what you read" plays once as it scrolls into view,
// and Replay plays it again. Kept in pass8.js beside the site tooling (patch-p8.py appends it). Without JavaScript,
// or when the reader has asked for less motion, it is simply the finished state. ====
(function () {
  if (!('IntersectionObserver' in window) || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('DOMContentLoaded', function () {
    var fig = document.querySelector('.tx');
    if (!fig) return;
    var again = fig.querySelector('.tx-again');
    var last = fig.querySelector('.tx-para p');
    fig.classList.add('tx-on');
    var play = function () {
      fig.classList.remove('is-play');
      void fig.offsetWidth; // restart the animations
      fig.classList.add('is-play');
    };
    last.addEventListener('animationend', function () { if (again) again.hidden = false; });
    if (again) again.addEventListener('click', play);
    var seen = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { play(); seen.disconnect(); }
    }, { threshold: 0.6 });
    seen.observe(fig.querySelector('.tx-card'));
    window.addEventListener('beforeprint', function () { fig.classList.remove('tx-on'); });
  });
})();

// ==== Pass 9 (2026-11-12): on the study tools page, the pack styles piece plays once as it scrolls into view (a style
// is chosen, then what the pack makes appears), and Replay plays it again. Kept in pass9.js beside the site tooling
// (patch-p9.py appends it). Without JavaScript, or when the reader has asked for less motion, it is the finished state. ====
(function () {
  if (!('IntersectionObserver' in window) || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('DOMContentLoaded', function () {
    var fig = document.querySelector('.ps');
    if (!fig) return;
    var again = fig.querySelector('.ps-again');
    var last = fig.querySelector('.ps-count');
    fig.classList.add('ps-js');
    var play = function () {
      fig.classList.remove('is-play');
      void fig.offsetWidth; // restart the animations
      fig.classList.add('is-play');
    };
    last.addEventListener('animationend', function () { if (again) again.hidden = false; });
    if (again) again.addEventListener('click', play);
    var seen = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { play(); seen.disconnect(); }
    }, { threshold: 0.6 });
    seen.observe(fig.querySelector('.ps-card'));
    window.addEventListener('beforeprint', function () { fig.classList.remove('ps-js'); });
  });
})();

// ==== Pass 10 (2026-11-12): the demo, one step at a time, and the study tools flow. Kept in pass10.js beside the
// site tooling (patch-p10.py appends it). Without JavaScript the demo is a list of its four steps, and the flow is
// its finished row. ====
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var dm = document.querySelector('.dm');
    if (!dm) return;
    var steps = [].slice.call(dm.querySelectorAll('.dm-step'));
    var ctrl = dm.querySelector('.dm-ctrl');
    var back = dm.querySelector('.dm-back');
    var next = dm.querySelector('.dm-next');
    var restart = dm.querySelector('.dm-restart');
    var at = dm.querySelector('.dm-at');
    var live = dm.querySelector('.dm-live');
    var n = steps.length;
    var i = 0;
    var show = function (to, moved) {
      var focused = ctrl.contains(document.activeElement);
      i = Math.max(0, Math.min(n - 1, to));
      steps.forEach(function (s, k) { s.classList.toggle('is-on', k === i); });
      dm.classList.toggle('is-last', i === n - 1);
      dm.classList.toggle('is-moved', !!moved);
      back.disabled = i === 0;
      next.hidden = i === n - 1;
      restart.hidden = i !== n - 1;
      at.textContent = String(i + 1);
      if (moved) {
        var say = steps[i].querySelector('.dm-say');
        var words = say ? say.textContent.replace(/^\s*\d+\s*/, '').replace(/\s+/g, ' ').trim() : '';
        live.textContent = 'Step ' + (i + 1) + ' of ' + n + ': ' + words;
      }
      // Focus stays on the controls: when the button pressed goes away, the one beside it takes the focus.
      if (focused && (document.activeElement.hidden || document.activeElement.disabled || !ctrl.contains(document.activeElement))) {
        (i === n - 1 ? restart : next).focus();
      }
    };
    dm.classList.add('is-js');
    ctrl.hidden = false;
    back.addEventListener('click', function () { show(i - 1, true); });
    next.addEventListener('click', function () { show(i + 1, true); });
    restart.addEventListener('click', function () { show(0, true); next.focus(); });
    ctrl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); show(i + 1, true); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); show(i - 1, true); }
      else if (e.key === 'Home') { e.preventDefault(); show(0, true); }
      else if (e.key === 'End') { e.preventDefault(); show(n - 1, true); }
    });
    show(0, false);
    window.addEventListener('beforeprint', function () { dm.classList.remove('is-js'); });
    window.addEventListener('afterprint', function () { dm.classList.add('is-js'); });
  });
})();
(function () {
  if (!('IntersectionObserver' in window) || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.addEventListener('DOMContentLoaded', function () {
    var fig = document.querySelector('.fl');
    if (!fig) return;
    var again = fig.querySelector('.fl-again');
    var items = fig.querySelectorAll('.fl-item');
    var last = items[items.length - 1];
    fig.classList.add('fl-js');
    var play = function () {
      fig.classList.remove('is-play');
      void fig.offsetWidth; // restart the animations
      fig.classList.add('is-play');
    };
    last.addEventListener('animationend', function () { if (again) again.hidden = false; });
    if (again) again.addEventListener('click', play);
    var seen = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { play(); seen.disconnect(); }
    }, { threshold: 0.5 });
    seen.observe(fig.querySelector('.fl-row'));
    window.addEventListener('beforeprint', function () { fig.classList.remove('fl-js'); });
  });
})();

// Pass 11 (2026-11-12): the home page's "Then study it" as three tabs switching one large picture. Without
// JavaScript the three pictures stand one under another. The arrow keys, Home and End move between the tabs.
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var boxes = document.querySelectorAll('[data-tabs]');
    for (var b = 0; b < boxes.length; b += 1) setUp(boxes[b]);
  });
  function setUp(box) {
    var list = box.querySelector('.stt-tabs');
    if (!list) return;
    var tabs = list.querySelectorAll('[data-for]');
    var panels = [];
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'What Pro makes from one lecture');
    for (var i = 0; i < tabs.length; i += 1) {
      var panel = document.getElementById(tabs[i].getAttribute('data-for'));
      panels.push(panel);
      tabs[i].id = tabs[i].id || 'tab-' + panel.id;
      tabs[i].setAttribute('role', 'tab');
      tabs[i].setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabs[i].id);
      panel.setAttribute('tabindex', '0');
    }
    var show = function (k, focus) {
      for (var j = 0; j < tabs.length; j += 1) {
        var on = j === k;
        tabs[j].setAttribute('aria-selected', on ? 'true' : 'false');
        tabs[j].tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      }
      if (focus) tabs[k].focus();
    };
    for (var t = 0; t < tabs.length; t += 1) {
      (function (k) {
        tabs[k].addEventListener('click', function () { show(k, false); });
        tabs[k].addEventListener('keydown', function (e) {
          var n = tabs.length;
          if (e.key === 'ArrowRight') { e.preventDefault(); show((k + 1) % n, true); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); show((k - 1 + n) % n, true); }
          else if (e.key === 'Home') { e.preventDefault(); show(0, true); }
          else if (e.key === 'End') { e.preventDefault(); show(n - 1, true); }
        });
      })(t);
    }
    list.hidden = false;
    box.classList.add('is-tabs');
    show(0, false);
    window.addEventListener('beforeprint', function () { for (var j = 0; j < panels.length; j += 1) panels[j].hidden = false; });
    window.addEventListener('afterprint', function () { for (var j = 0; j < tabs.length; j += 1) if (tabs[j].getAttribute('aria-selected') === 'true') show(j, false); });
  }
})();
