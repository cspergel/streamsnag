// StreamSnag website: the working copy of the popup at the top of the home page. Nothing is downloaded and
// nothing is sent anywhere: the buttons only change what this drawing shows. The minutes, the quiz and the
// flashcard need no script at all.
//
// The lecture goes through six states: '0' found, '0b' downloading, '1' saved, '1b' transcribing,
// '2' transcript saved, '3' reading edition made. Each element with data-show lists the states it is
// shown in. For people who ask for reduced motion the in-between states are skipped: a click goes
// straight to its result, and the numbered steps above the browser jump to any state.
//
// The words are the real popup's own (extension/lib/wording.js, lib/strip.js, lib/review.js, pro/path.js):
// when one of them changes there, it changes here.
(function () {
  var fig = document.querySelector('.scene-fig');
  if (!fig) return;
  var scene = fig.querySelector('.scene');
  var $ = function (sel) { return fig.querySelector(sel); };
  var all = function (sel) { return Array.prototype.slice.call(fig.querySelectorAll(sel)); };
  var say = function (name, text) { var el = $('[data-say="' + name + '"]'); if (el) el.textContent = text; };
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var fill = $('.xp-lecture .xp-fill');
  var file = $('.xp-file');
  var show = $('[data-act="show"]');
  var filesBtn = $('[data-act="files"]');
  var filesList = $('.xp-files');
  var sheet = $('.xp-sheet');
  var openSheet = $('[data-act="open-sheet"]');
  var go = $('[data-act="go"]');
  var reset = $('[data-act="reset"]');
  var doc = $('#demo-read');
  var lectureTab = document.getElementById('pg-lecture');
  var steps = all('[data-step]');
  var boxes = all('.xp-sheet input[type="checkbox"]');
  var shown = all('[data-show]');
  var cells = all('.xp-cells i');
  var timers = [];
  var FOLDER = 'Downloads › StreamSnag › PHYS201';
  var AT_ONCE = 2; // "Downloads at once" in the real one's Settings, as it comes
  var first = { ticked: boxes.map(function (b) { return b.checked; }), cells: cells.map(function (c) { return c.className; }) };

  // What a person hears: one polite line for each thing that happens.
  var live = document.createElement('p');
  live.className = 'vh';
  live.setAttribute('role', 'status');
  fig.appendChild(live);
  var tell = function (text) { live.textContent = text; };

  function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function stop() { timers.forEach(clearTimeout); timers = []; }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function focus(sel) { var el = $(sel); if (el && !el.hidden) el.focus(); }
  function megabytes(mb) { return mb < 1024 ? Math.round(mb) + ' MB' : (mb / 1024).toFixed(1) + ' GB'; }

  function setState(state) {
    scene.setAttribute('data-state', state);
    shown.forEach(function (el) { el.hidden = el.getAttribute('data-show').split(' ').indexOf(state) < 0; });
    var at = state === '3' ? 4 : Number(state.charAt(0)) + 1; // the step that comes next
    steps.forEach(function (b) {
      var n = Number(b.getAttribute('data-step'));
      if (n === at) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('is-done', n < at);
    });
    say('activity', state === '0b' || state === '1b' ? '1' : '· idle');
    file.hidden = true;
    show.setAttribute('aria-expanded', 'false');
  }

  // ---- step 1: download, then where it went
  function download() {
    stop();
    if (still) { setState('1'); tell('Saved to Downloads, StreamSnag'); focus('[data-act="transcribe"]'); return; }
    setState('0b');
    say('dl', 'Starting…');
    fill.style.width = '4%';
    tell('Download started');
    focus('[data-act="cancel"]');
    later(500, function () { say('dl', '42% · about 20 s left'); fill.style.width = '42%'; });
    later(1500, function () { say('dl', '88% · about 5 s left'); fill.style.width = '88%'; });
    later(2500, function () {
      setState('1');
      fill.style.width = '0';
      tell('Saved to Downloads, StreamSnag');
      focus('[data-act="transcribe"]');
    });
  }
  // ---- step 2: the words, made on this computer
  function transcribe() {
    stop();
    if (still) { setState('2'); tell('Transcript saved next to the video'); focus('[data-act="read"]'); return; }
    setState('1b');
    tell('Transcribing on this computer');
    later(2400, function () {
      setState('2');
      tell('Transcript saved next to the video');
      focus('[data-act="read"]');
    });
  }
  // ---- step 3: the lecture as a document. The real one opens it in a tab of its own; here it is beside the popup.
  function read() {
    stop();
    setState('3');
    tell('Reading edition saved: 4 sections, about 14 minutes to read');
    if (doc) doc.focus();
  }

  // ---- a course page: the strip, and the sheet before anything starts
  function stateOf(i) { return (/c-(\w+)/.exec(cells[i].className) || [])[1]; }
  function setCell(i, state) { cells[i].className = 'c-' + state + (i === 0 ? ' here' : ''); }
  function rowOf(box) { return box.parentNode; }
  function cellOf(box) { return Number(rowOf(box).getAttribute('data-cell')); }
  function open(box) { return !rowOf(box).hidden; } // not saved yet, so still offered on the sheet

  // The strip in words, as the real popup counts it.
  function strip() {
    var counts = { saved: 0, busy: 0, get: 0, check: 0 };
    cells.forEach(function (c, i) { counts[stateOf(i)] += 1; });
    var words = [['saved', ' saved'], ['busy', ' saving now'], ['get', ' to get'], ['check', ' to check']]
      .filter(function (w) { return counts[w[0]] > 0; });
    var legend = $('[data-fill="legend"]');
    legend.textContent = '';
    words.forEach(function (w) {
      var li = document.createElement('li');
      var i = document.createElement('i');
      i.className = 'c-' + w[0];
      li.appendChild(i);
      li.appendChild(document.createTextNode(counts[w[0]] + w[1]));
      legend.appendChild(li);
    });
    $('.xp-cells').setAttribute('aria-label', '8 videos on this page: ' + words.map(function (w) { return counts[w[0]] + w[1]; }).join(', ') + '.');
    var label = counts.get ? 'Download the ' + counts.get + ' missing…' : counts.check ? 'Review ' + counts.check + ' to check…' : '';
    say('bulk-btn', label);
    openSheet.hidden = !label;
    return counts;
  }

  function count() {
    var offered = boxes.filter(open);
    var picked = offered.filter(function (b) { return b.checked; });
    var n = picked.length;
    var groups = all('.xp-sheet .rv-group');
    groups.forEach(function (g) {
      var left = all('.xp-sheet .rv-item').filter(function (r) { return r.parentNode === g && !r.hidden; }).length;
      g.hidden = !left;
      g.querySelector('.rv-count').textContent = left;
    });
    var look = groups[1].hidden ? 0 : Number(groups[1].querySelector('.rv-count').textContent);
    say('summary', (n ? plural(n, 'video') + ' selected' : 'Nothing selected') + (look ? ' · ' + look + (look === 1 ? ' needs' : ' need') + ' a look' : ''));
    var have = boxes.length - offered.length;
    var haveLine = $('[data-say="have"]');
    haveLine.hidden = !have;
    haveLine.textContent = have ? have + ' already in your folders: skipped.' : '';
    var mb = picked.reduce(function (sum, b) { return sum + Number(b.getAttribute('data-mb')); }, 0);
    say('total', mb ? 'About ' + megabytes(mb) + ' in all' : '');
    go.textContent = 'Download ' + n;
    go.disabled = !n;
    return picked;
  }
  function closeSheet(focusBack) {
    sheet.hidden = true;
    if (focusBack && !openSheet.hidden) openSheet.focus();
  }
  function saved(list) {
    list.forEach(function (b) { setCell(cellOf(b), 'saved'); rowOf(b).hidden = true; });
    // The lecture in front is one of them: its card says where it went.
    if (stateOf(0) === 'saved') {
      $('[data-act="one"]').hidden = true;
      $('[data-one="busy"]').hidden = true;
      $('[data-one="done"]').hidden = false;
    }
    strip();
    count();
  }
  function bulk() {
    var picked = count();
    var n = picked.length;
    if (!n) return;
    closeSheet(true);
    var done = n > 1 ? n + ' saved to ' + FOLDER : 'You review the list first.';
    if (still) { saved(picked); say('bulk', done); tell(n + ' saved to Downloads, StreamSnag, PHYS201'); return; }
    picked.forEach(function (b) { setCell(cellOf(b), 'busy'); });
    strip();
    // One download is said on its own card; several are said here, as the real one does.
    if (n > 1) say('bulk', 'Downloading ' + n + (n > AT_ONCE ? ' · ' + (n - AT_ONCE) + ' waiting ' + (n - AT_ONCE === 1 ? 'its' : 'their') + ' turn' : ' · about 1 min left'));
    say('activity', String(n));
    tell(plural(n, 'download') + ' started');
    later(2600, function () {
      saved(picked);
      say('bulk', done);
      say('activity', '· idle');
      tell(n + ' saved to Downloads, StreamSnag, PHYS201');
    });
  }
  // The lecture in front on the course page: its own button saves that one.
  function one() {
    var btn = $('[data-act="one"]');
    var busy = $('[data-one="busy"]');
    var box = boxes.filter(function (b) { return cellOf(b) === 0; })[0];
    var finish = function () {
      saved([box]);
      tell('Saved to Downloads, StreamSnag, PHYS201');
      if (!openSheet.hidden) openSheet.focus();
    };
    if (stateOf(0) !== 'get') return;
    btn.hidden = true;
    if (still) { finish(); return; }
    busy.hidden = false;
    setCell(0, 'busy');
    strip();
    tell('Download started');
    later(1400, finish);
  }

  function startOver() {
    stop();
    setState('0');
    closeSheet(false);
    say('bulk', 'You review the list first.');
    all('[data-act="file"]').forEach(function (b) { b.disabled = false; b.textContent = 'Download'; });
    filesList.hidden = true;
    filesBtn.setAttribute('aria-expanded', 'false');
    boxes.forEach(function (b, i) { b.checked = first.ticked[i]; rowOf(b).hidden = false; });
    cells.forEach(function (c, i) { c.className = first.cells[i]; });
    $('[data-act="one"]').hidden = false;
    $('[data-one="busy"]').hidden = true;
    $('[data-one="done"]').hidden = true;
    strip();
    count();
    if (lectureTab) lectureTab.checked = true;
    tell('The demo is back at the start');
    focus('[data-act="download"]');
  }

  fig.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act], [data-step]') : null;
    if (!el || !fig.contains(el)) return;
    if (el.hasAttribute('data-step')) {
      // The numbered steps jump to the moment before that click.
      var n = Number(el.getAttribute('data-step'));
      stop();
      if (lectureTab) lectureTab.checked = true;
      closeSheet(false);
      setState(['0', '1', '2'][n - 1]);
      focus(['[data-act="download"]', '[data-act="transcribe"]', '[data-act="read"]'][n - 1]);
      return;
    }
    var act = el.getAttribute('data-act');
    if (act === 'download') download();
    else if (act === 'cancel') { stop(); setState('0'); tell('Download cancelled'); focus('[data-act="download"]'); }
    else if (act === 'show') {
      var open2 = file.hidden;
      file.hidden = !open2;
      show.setAttribute('aria-expanded', String(open2));
    } else if (act === 'transcribe') transcribe();
    else if (act === 'read') read();
    else if (act === 'open-read') { if (doc) doc.focus(); }
    else if (act === 'files') {
      var was = el.getAttribute('aria-expanded') === 'true';
      el.setAttribute('aria-expanded', String(!was));
      filesList.hidden = was;
    } else if (act === 'file') {
      el.textContent = 'Downloaded';
      el.disabled = true;
      tell('File downloaded');
    } else if (act === 'one') one();
    else if (act === 'open-sheet') {
      stop();
      // (A download cut short by opening the sheet again goes back to where it was.)
      cells.forEach(function (c, i) { if (stateOf(i) === 'busy') setCell(i, boxes.filter(function (b) { return cellOf(b) === i; })[0].closest('.rv-group').getAttribute('aria-labelledby') === 'rv-check-h' ? 'check' : 'get'); });
      if ($('[data-one="busy"]').hidden === false) { $('[data-one="busy"]').hidden = true; $('[data-act="one"]').hidden = false; }
      strip();
      say('bulk', 'You review the list first.');
      say('activity', '· idle');
      sheet.hidden = false;
      count();
      sheet.focus();
    } else if (act === 'close-sheet') closeSheet(true);
    else if (act === 'go') bulk();
    else if (act === 'reset') startOver();
  });
  fig.addEventListener('change', function (e) {
    if (e.target.type === 'checkbox' && sheet.contains(e.target)) count();
    // Leaving the course page closes its sheet.
    if (e.target.name === 'pg') closeSheet(false);
  });
  sheet.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeSheet(true); }
  });

  strip();
  count();
  if (reset) reset.hidden = false;
  scene.classList.add('is-live');
})();
