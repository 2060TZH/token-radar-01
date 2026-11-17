// Token Radar page: filters, sorting, hash-routed detail views. No network: every byte
// renders from window.RADAR, written beside this page by main.ts.
(function () {
  'use strict';
  var D = window.RADAR;
  var rows = D.rows;
  var watchlist = new Set();
  rows.forEach(function (r) { if (r.watchlist) watchlist.add(r.slug); });

  var state = { q: '', cat: '', chain: '', scope: 'all', pretoken: false, sortKey: 'rank', sortDir: 1 };
  var detailSlug = null;

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function trim2(x) {
    var s = x.toFixed(2);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
  function money(n) {
    if (n >= 1e9) return '$' + trim2(n / 1e9) + 'B';
    if (n >= 1e6) return '$' + trim2(n / 1e6) + 'M';
    if (n >= 1e3) return '$' + trim2(n / 1e3) + 'K';
    return '$' + n;
  }
  function full(n) { return '$' + n.toLocaleString('en-US'); }
  function pct(x) {
    if (x === null || x === undefined) return '<span class="dim">—</span>';
    var v = Math.abs(x) < 0.05 ? 0 : x;
    var cls = v > 0 ? 'up' : v < 0 ? 'down' : 'dim';
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function ageText(a) { return a === null || a === undefined ? '<span class="dim">—</span>' : a + 'd'; }

  // ---- header, stats, model section -------------------------------------------
  $('lede').textContent = 'The board ranks ' + D.board_size + ' pre-token protocols by implied launch value — all ' +
    D.watchlist_size + ' protocols on the snapshot\u2019s watchlist, plus the ' + D.early_size +
    ' highest-TVL pre-token protocols below the $' + (D.floor_usd / 1e6) + 'M floor.';
  $('meta').textContent = 'Snapshot: ' + D.as_of + ' · ' + D.source + ' · Model ' + D.model_version;
  $('stats').innerHTML = [
    ['board_size', 'ranked pre-token protocols'],
    ['watchlist_size', 'watchlist protocols covered'],
    ['early_size', 'early protocols below the floor'],
    ['live_size', 'live tokens set aside, by market cap'],
  ].map(function (kv) {
    return '<div class="stat"><b>' + D[kv[0]] + '</b><span>' + kv[1] + '</span></div>';
  }).join('');

  $('model-text').innerHTML =
    'Implied value = <code>TVL × category multiple × growth multiplier × maturity multiplier</code>. ' +
    'The category multiple is the median market-cap-to-TVL ratio of the snapshot\u2019s own live-token protocols ' +
    'in that category (at least 3 comps; otherwise the global median across all live-token protocols), clamped to ' +
    '0.05–2.00. The growth multiplier is <code>1 + clamped 7-day TVL change ÷ 100 × 0.5</code> (change clamped to ' +
    '−60%…+120%; unreported counts as 0). The maturity multiplier is <code>0.6 + min(age, 1095) ÷ 1095 × 0.4</code> ' +
    '(unknown listing date counts as 365 days). Nothing is hardcoded by name: the same formula scores every row, ' +
    'and every multiple below comes from this snapshot\u2019s own live-token comps.';
  $('multiple-rows').innerHTML = D.multiples.map(function (m) {
    var label = m.category === null ? 'All categories (global fallback)' : m.category;
    var source = m.fallback ? 'global median — fewer than 3 comps in this category' : 'median of ' + m.comps + ' live comps';
    return '<tr><td>' + esc(label) + '</td><td class="num">' + m.multiple.toFixed(4) + '</td><td class="num">' + m.comps + '</td><td>' + esc(source) + '</td></tr>';
  }).join('');

  // ---- filter controls ----------------------------------------------------------
  function uniqSorted(values) {
    return Array.from(new Set(values)).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  }
  var cats = uniqSorted(rows.map(function (r) { return r.category; }).filter(function (c) { return c !== null; }));
  var chains = uniqSorted(rows.reduce(function (acc, r) { return acc.concat(r.chains); }, []));
  cats.forEach(function (c) { $('cat').appendChild(new Option(c, c)); });
  $('cat').appendChild(new Option('No category', '__null__'));
  chains.forEach(function (c) { $('chain').appendChild(new Option(c, c)); });

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.cat === '__null__') { if (r.category !== null) return false; }
      else if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.scope === 'watchlist' && !r.watchlist) return false;
      if (state.scope === 'early' && r.watchlist) return false;
      return true;
    });
  }
  function sorted(list) {
    var k = state.sortKey, dir = state.sortDir;
    function val(r) {
      if (k === 'name') return r.name.toLowerCase();
      if (k === 'category') return (r.category || '').toLowerCase();
      if (k === 'chains') return (r.chains[0] || '').toLowerCase();
      return r[k];
    }
    return list.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }
  function renderBoard() {
    var list = sorted(filtered());
    $('rows').innerHTML = list.map(function (r) {
      var badge = r.watchlist ? '<span class="badge">watchlist</span>' : '<span class="badge early">early</span>';
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === detailSlug ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + badge + '<br><span class="dim">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ') || '—') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td></tr>';
    }).join('');
    $('count').textContent = 'Showing ' + list.length + ' of ' + rows.length + ' ranked rows.';
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '#detail=' + tr.getAttribute('data-slug'); });
    });
    var heads = document.querySelectorAll('#board th[data-k]');
    Array.prototype.forEach.call(heads, function (th) {
      var k = th.getAttribute('data-k');
      var arrow = k === state.sortKey ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + arrow;
    });
  }

  // ---- detail view ---------------------------------------------------------------
  function renderDetail() {
    var box = $('detail');
    if (!detailSlug) { box.hidden = true; box.innerHTML = ''; return; }
    var r = rows.filter(function (x) { return x.slug === detailSlug; })[0];
    if (!r) {
      box.hidden = false;
      box.innerHTML = '<h2>Not on this board</h2><p class="sub">No protocol with slug ' + esc(detailSlug) + ' is among the ' + rows.length + ' ranked rows.</p><p><a href="#board">Back to the board</a></p>';
      return;
    }
    var m = r.model;
    var multNote = m.category_comps >= 3
      ? 'Median mcap / TVL of ' + m.category_comps + ' live-token comps in ' + (r.category || 'this category') + '.'
      : 'Fewer than 3 live-token comps in this category, so the global median across all live-token protocols is used.';
    var growthNote = r.change_7d === null ? '7-day change unreported, counted as 0%.' : '7-day TVL change ' + (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%, clamped to −60%…+120%.';
    box.hidden = false;
    box.innerHTML =
      '<h2>#' + r.rank + ' · ' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'No category') + ' · ' + esc(r.chains.join(', ') || 'no chains listed') +
      ' · ' + (r.watchlist ? 'on the watchlist' : 'early, below the floor') + ' · records no token</p>' +
      '<div class="kv">' +
      '<div><span>Implied value</span><b>' + full(r.implied_value_usd) + '</b></div>' +
      '<div><span>TVL</span><b>' + full(r.tvl_usd) + '</b></div>' +
      '<div><span>7-day change</span><b>' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</b></div>' +
      '<div><span>Age</span><b>' + (r.age_days === null ? 'unknown' : r.age_days + ' days') + '</b></div>' +
      '</div>' +
      '<h3>The model math</h3>' +
      '<p class="math">' + full(r.tvl_usd) + ' TVL × <b>' + m.category_multiple.toFixed(4) + '</b> category multiple × <b>' +
      m.growth_multiplier.toFixed(4) + '</b> growth × <b>' + m.maturity_multiplier.toFixed(4) +
      '</b> maturity = <b class="result">' + full(r.implied_value_usd) + '</b></p>' +
      '<p class="hint">' + esc(multNote) + ' ' + esc(growthNote) + ' Maturity: 0.6 + min(' +
      (m.age_days === null ? '365 (unknown listing date)' : m.age_days) + ', 1095) ÷ 1095 × 0.4 = ' + m.maturity_multiplier.toFixed(4) + '.</p>' +
      '<h3>How to farm it</h3>' +
      '<ol class="farm">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p style="margin-top:16px"><a href="#board">Back to the board</a></p>';
  }

  // ---- live-token section ----------------------------------------------------------
  $('live-rows').innerHTML = D.live.map(function (p) {
    return '<tr><td><b>' + esc(p.name) + '</b><br><span class="dim">' + esc(p.slug) + '</span></td>' +
      '<td>' + esc(p.category || '—') + '</td>' +
      '<td>' + esc(p.chains.slice(0, 2).join(', ') || '—') + '</td>' +
      '<td class="num">' + money(p.mcap_usd) + '</td>' +
      '<td class="num">' + money(p.tvl_usd) + '</td>' +
      '<td class="num">' + pct(p.change_7d) + '</td></tr>';
  }).join('');

  // ---- hash routing ------------------------------------------------------------------
  function applyHash() {
    var h = location.hash || '#board';
    detailSlug = null;
    if (h.indexOf('#detail=') === 0) {
      detailSlug = decodeURIComponent(h.slice(8));
      $('filter-note').hidden = true;
    } else if (h === '#filtered') {
      state.cat = 'Lending';
      $('cat').value = 'Lending';
      var n = filtered().length;
      $('filter-note').hidden = false;
      $('filter-note').textContent = 'Filtered view: category = Lending. ' + n + ' rows match. Change the filters above to explore the rest of the board.';
    } else {
      $('filter-note').hidden = true;
    }
    renderBoard();
    renderDetail();
    $('live-section').style.display = state.pretoken ? 'none' : '';
    if (detailSlug) window.scrollTo(0, 0);
  }

  // ---- events --------------------------------------------------------------------------
  $('q').addEventListener('input', function () { state.q = this.value; renderBoard(); });
  $('cat').addEventListener('change', function () { state.cat = this.value; renderBoard(); });
  $('chain').addEventListener('change', function () { state.chain = this.value; renderBoard(); });
  $('scope').addEventListener('change', function () { state.scope = this.value; renderBoard(); });
  $('pretoken').addEventListener('change', function () {
    state.pretoken = this.checked;
    $('live-section').style.display = this.checked ? 'none' : '';
  });
  $('reset').addEventListener('click', function () {
    state.q = ''; state.cat = ''; state.chain = ''; state.scope = 'all'; state.pretoken = false;
    $('q').value = ''; $('cat').value = ''; $('chain').value = ''; $('scope').value = 'all'; $('pretoken').checked = false;
    $('live-section').style.display = '';
    location.hash = '#board';
    renderBoard();
  });
  Array.prototype.forEach.call(document.querySelectorAll('#board th[data-k]'), function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (state.sortKey === k) state.sortDir = -state.sortDir;
      else { state.sortKey = k; state.sortDir = (k === 'rank' || k === 'name' || k === 'category' || k === 'chains') ? 1 : -1; }
      renderBoard();
    });
  });
  window.addEventListener('hashchange', applyHash);
  applyHash();
})();
