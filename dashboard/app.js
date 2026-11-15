// Launch Radar's page. It reads window.RADAR (data.js, written beside dashboard/ by main.ts)
// and renders the ranked board, a traded-comparables table, filters and a detail view for every
// protocol. No network: every byte it shows arrived in data.js.
//
// The page recomputes each row's implied value from the snapshot figures and the model's
// constants, with the same arithmetic as lib/model.ts, and the detail view shows the working
// next to the number board.json carries — so the code and the board can be checked against
// each other by eye.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('app');
  if (!DATA || !app) return;

  var C = DATA.constants;
  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });

  // ---------- formatting ----------
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unreported';
    if (days >= 730) return (days / 365).toFixed(1) + ' yrs';
    if (days >= 365) return '1.0 yrs';
    if (days >= 30) return Math.round(days / 30.4) + ' mo';
    return days + ' d';
  }
  function fmtMult(n) { return n.toFixed(2) + 'x'; }

  // ---------- the model, recomputed in the page ----------
  function multipleFor(row) {
    var entry = row.category ? DATA.multiples.categories[row.category] : null;
    if (entry) return entry;
    return { multiple: DATA.multiples.global, samples: DATA.multiples.global_samples, basis: 'global' };
  }
  function impliedOf(row) {
    var m = multipleFor(row);
    var change = Math.min(C.growth_cap_pct, Math.max(C.growth_floor_pct, row.change_7d === null ? 0 : row.change_7d));
    var momentum = 1 + (change / 100) * C.growth_weight;
    var age = row.age_days === null ? C.unknown_age_days : row.age_days;
    var seasoning = C.seasoning_floor + (1 - C.seasoning_floor) * (Math.min(age, C.seasoning_full_days) / C.seasoning_full_days);
    var extra = Math.min(Math.max(row.chains.length - 1, 0), C.breadth_max_extra);
    var breadth = 1 + C.breadth_per_chain * extra;
    return {
      multiple: m, momentum: momentum, seasoning: seasoning, breadth: breadth,
      value: Math.max(1, Math.round(row.tvl_usd * m.multiple * momentum * seasoning * breadth)),
    };
  }

  // ---------- tiny DOM helper ----------
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string' || typeof child === 'number') node.appendChild(document.createTextNode(String(child)));
      else node.appendChild(child);
    }
    return node;
  }

  // ---------- state and hash routing ----------
  var board = { tab: 'radar', seg: 'all', q: '', category: 'all', chain: 'all', sort: 'rank', dir: 1 };
  var view = { name: 'board' };

  function parseHash() {
    var hash = location.hash || '';
    if (hash.indexOf('#/p/') === 0) {
      var slug = decodeURIComponent(hash.slice(4));
      if (bySlug[slug]) { view = { name: 'detail', slug: slug }; return; }
    }
    if (hash.indexOf('#/board') === 0) {
      var q = hash.slice(hash.indexOf('?') + 1);
      if (hash.indexOf('?') > 0) {
        q.split('&').forEach(function (pair) {
          var kv = pair.split('=');
          var key = decodeURIComponent(kv[0] || '');
          var val = decodeURIComponent(kv[1] || '');
          if (key === 'seg' && ['all', 'watchlist', 'early'].indexOf(val) >= 0) board.seg = val;
          if (key === 'tab' && ['radar', 'live'].indexOf(val) >= 0) board.tab = val;
          if (key === 'cat') board.category = val;
          if (key === 'chain') board.chain = val;
          if (key === 'q') board.q = val;
        });
      }
    }
    view = { name: 'board' };
  }

  function goDetail(slug) { location.hash = '#/p/' + encodeURIComponent(slug); }
  function goBoard() { location.hash = '#/board'; }

  // ---------- shared pieces ----------
  function statStrip() {
    var s = DATA.stats;
    function stat(k, v, sub) {
      return h('div', { class: 'stat' },
        h('div', { class: 'k', text: k }),
        h('div', { class: 'v' }, v),
        h('div', { class: 's', text: sub }));
    }
    return h('section', { class: 'stats' },
      stat('Protocols scanned', String(s.protocols_scanned), 'every protocol in the snapshot'),
      stat('Record no token', String(s.pretoken_found), 'no market cap, no listing, no symbol'),
      stat('Watchlist covered', s.watchlist_rows + ' / ' + s.watchlist_rows, 'the floor: all ' + s.watchlist_rows + ' ranked'),
      stat('Early rows added', String(s.early_rows), 'below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor, found by the screen'),
      stat('Traded comparables', String(DATA.multiples.global_samples), 'live tokens the multiples stand on'));
  }

  function modelStrip() {
    return h('section', { class: 'model' },
      h('h2', { text: 'How a launch is valued here' }),
      h('p', { text: 'Each protocol that records no token is priced off the protocols that already trade: the market pays a median of ' +
        fmtMult(DATA.multiples.global) + ' of market cap per $1 of TVL across ' + DATA.multiples.global_samples +
        ' traded protocols, and each category with at least ' + C.multiple_min_samples + ' traded peers uses its own median instead. ' +
        'That base is then moved by the protocol\'s own seven-day TVL momentum, by how long it has run with no token, and by its chain breadth. ' +
        'No name is special-cased: one function values every row, and the detail view shows its working.' }),
      h('div', { class: 'formula', text: 'implied value = TVL x category multiple x momentum factor x seasoning factor x breadth factor' }),
      h('div', { class: 'factors' },
        h('span', null, h('b', { text: 'Momentum ' }), '7d change clamped to ' + C.growth_floor_pct + '%..+' + C.growth_cap_pct + '%, weight ' + C.growth_weight),
        h('span', null, h('b', { text: 'Seasoning ' }), C.seasoning_floor + ' on day one, rising to 1.00 at ' + (C.seasoning_full_days / 365) + ' years'),
        h('span', null, h('b', { text: 'Breadth ' }), '+' + (C.breadth_per_chain * 100) + '% per extra chain, up to ' + C.breadth_max_extra),
        h('span', null, h('b', { text: 'Multiples ' }), 'held inside ' + C.multiple_floor + 'x..' + C.multiple_cap + 'x')));
  }

  // ---------- board ----------
  function filteredRows() {
    var q = board.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (board.seg === 'watchlist' && !r.on_watchlist) return false;
      if (board.seg === 'early' && r.on_watchlist) return false;
      if (board.category !== 'all' && r.category !== board.category) return false;
      if (board.chain !== 'all' && r.chains.indexOf(board.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }

  function sortedRows(rows) {
    var key = board.sort, dir = board.dir;
    var val = function (r) {
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -Infinity : r.change_7d;
      if (key === 'age') return r.age_days === null ? -1 : r.age_days;
      if (key === 'implied') return r.implied_value_usd;
      if (key === 'ready') return r.readiness;
      return r.rank;
    };
    return rows.slice().sort(function (a, b) {
      var d = (val(a) - val(b)) * dir;
      return d !== 0 ? d : a.rank - b.rank;
    });
  }

  function controls() {
    var cats = [];
    var chains = [];
    DATA.rows.forEach(function (r) {
      if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
      r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
    });
    cats.sort(); chains.sort();

    function segBtn(id, label) {
      return h('button', {
        type: 'button', 'aria-pressed': board.seg === id ? 'true' : 'false',
        onclick: function () { board.seg = id; render(); },
      }, label);
    }
    var search = h('input', { type: 'search', placeholder: 'Search name or slug', value: board.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { board.q = search.value; renderTableOnly(); });
    var catSel = h('select', { 'aria-label': 'Category' },
      h('option', { value: 'all' }, 'All categories'),
      cats.map(function (c) { return h('option', { value: c }, c); }));
    catSel.value = board.category;
    catSel.addEventListener('change', function () { board.category = catSel.value; render(); });
    var chainSel = h('select', { 'aria-label': 'Chain' },
      h('option', { value: 'all' }, 'All chains'),
      chains.map(function (c) { return h('option', { value: c }, c); }));
    chainSel.value = board.chain;
    chainSel.addEventListener('change', function () { board.chain = chainSel.value; render(); });

    return h('div', { class: 'controls' },
      h('div', { class: 'seg' }, segBtn('all', 'Full board'), segBtn('watchlist', 'Watchlist'), segBtn('early', 'Early radar')),
      search, catSel, chainSel,
      h('span', { class: 'count', id: 'rowCount' }));
  }

  var tableHost = null;
  function renderTableOnly() {
    if (!tableHost) { render(); return; }
    var fresh = boardTable();
    tableHost.replaceWith(fresh);
    tableHost = fresh;
    var count = document.getElementById('rowCount');
    if (count) count.textContent = countText();
  }
  function countText() {
    return board.tab === 'live'
      ? DATA.live.length + ' traded protocols'
      : filteredRows().length + ' of ' + DATA.rows.length + ' rows';
  }

  function sortHead(label, key, cls) {
    var arrow = board.sort === key ? (board.dir === 1 ? ' ↑' : ' ↓') : '';
    return h('th', {
      class: 'sortable ' + (cls || ''), scope: 'col',
      onclick: function () {
        if (board.sort === key) board.dir = -board.dir;
        else { board.sort = key; board.dir = key === 'rank' ? 1 : -1; }
        render();
      },
    }, label, h('span', { class: 'dir', text: arrow }));
  }

  function readinessCell(r) {
    return h('td', null,
      h('div', { class: 'ready' },
        h('span', { class: 'bar' }, h('i', { style: 'width:' + r.readiness + '%' })),
        h('span', { class: 'n', text: String(r.readiness) })));
  }

  function boardTable() {
    if (board.tab === 'live') return liveTable();
    var rows = sortedRows(filteredRows());
    var head = h('tr', null,
      sortHead('#', 'rank'), h('th', { scope: 'col' }, 'Protocol'), h('th', { scope: 'col' }, 'Category'),
      h('th', { scope: 'col' }, 'Chains'), sortHead('TVL', 'tvl'), sortHead('7d', 'change'),
      sortHead('Age', 'age'), h('th', { scope: 'col' }, 'Multiple'), sortHead('Implied value', 'implied'), sortHead('Ready', 'ready'));
    var body = rows.map(function (r) {
      var change = h('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') }, fmtPct(r.change_7d));
      return h('tr', { onclick: function () { goDetail(r.slug); }, tabindex: '0', title: 'Open the detail view for ' + r.name },
        h('td', { class: 'rank', text: String(r.rank) }),
        h('td', null,
          h('span', { class: 'pname', text: r.name }),
          r.on_watchlist ? h('span', { class: 'mark watch', text: 'Watchlist' }) : h('span', { class: 'mark early', text: 'Early' }),
          h('div', { class: 'pslug', text: r.slug })),
        h('td', { class: 'cat', text: r.category || 'Uncategorised' }),
        h('td', { class: 'chains', text: r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') }),
        h('td', { class: 'num' }, fmtUsd(r.tvl_usd)),
        change,
        h('td', { class: 'num' }, fmtAge(r.age_days)),
        h('td', { class: 'num' }, fmtMult(r.valuation.multiple)),
        h('td', { class: 'implied' }, fmtUsd(r.implied_value_usd)),
        readinessCell(r));
    });
    var table = h('table', null, h('thead', null, head), h('tbody', null, body));
    if (rows.length === 0) return h('div', { class: 'tablewrap' }, h('div', { class: 'empty', text: 'No protocol matches this filter. Loosen the search, the category or the chain.' }));
    return h('div', { class: 'tablewrap' }, table);
  }

  function liveTable() {
    var head = h('tr', null,
      h('th', { scope: 'col' }, 'Protocol'), h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col' }, 'Chains'),
      h('th', { scope: 'col' }, 'TVL'), h('th', { scope: 'col' }, 'Market cap'), h('th', { scope: 'col' }, 'Mcap / TVL'), h('th', { scope: 'col' }, '7d'));
    var body = DATA.live.map(function (r) {
      return h('tr', { style: 'cursor:default' },
        h('td', null, h('span', { class: 'pname', text: r.name }), h('div', { class: 'pslug', text: r.slug })),
        h('td', { class: 'cat', text: r.category || 'Uncategorised' }),
        h('td', { class: 'chains', text: r.chains.slice(0, 3).join(', ') }),
        h('td', { class: 'num' }, fmtUsd(r.tvl_usd)),
        h('td', { class: 'num' }, fmtUsd(r.mcap_usd)),
        h('td', { class: 'num' }, fmtMult(r.ratio)),
        h('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') }, fmtPct(r.change_7d)));
    });
    return h('div', null,
      h('p', { class: 'note', text: 'These protocols already trade, so the radar never ranks them: the market has priced them itself. They are the comparables — each category\'s median mcap/TVL here is the multiple the board applies to the pre-token protocols of that category.' }),
      h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, head), h('tbody', null, body))));
  }

  function renderBoard() {
    var tabs = h('div', { class: 'tabs' },
      h('button', { type: 'button', 'aria-pressed': board.tab === 'radar' ? 'true' : 'false', onclick: function () { board.tab = 'radar'; render(); } }, 'The board'),
      h('button', { type: 'button', 'aria-pressed': board.tab === 'live' ? 'true' : 'false', onclick: function () { board.tab = 'live'; render(); } }, 'Traded comparables'));
    app.appendChild(statStrip());
    app.appendChild(modelStrip());
    app.appendChild(tabs);
    if (board.tab === 'radar') app.appendChild(controls());
    tableHost = boardTable();
    app.appendChild(tableHost);
    var count = document.getElementById('rowCount');
    if (count) count.textContent = countText();
  }

  // ---------- detail ----------
  function kv(k, v, plain) {
    return h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' + (plain ? ' plain' : ''), text: v }));
  }

  function renderDetail(slug) {
    var r = bySlug[slug];
    var v = impliedOf(r);
    var mult = v.multiple;
    app.appendChild(h('button', { class: 'backlink', type: 'button', onclick: goBoard }, '← Back to the board'));
    app.appendChild(h('div', { class: 'detail-head' },
      h('h2', { text: r.name }),
      r.on_watchlist ? h('span', { class: 'mark watch', text: 'Watchlist' }) : h('span', { class: 'mark early', text: 'Early radar' }),
      h('span', { class: 'sub', text: 'rank #' + r.rank + ' of ' + DATA.rows.length + ' · ' + r.slug })));

    var record = h('div', { class: 'card' },
      h('h3', { text: 'The record' }),
      kv('Category', r.category || 'Uncategorised', true),
      kv('Chains', r.chains.join(', ') || 'none named', true),
      kv('TVL', fmtUsd(r.tvl_usd)),
      kv('TVL change, 7 days', fmtPct(r.change_7d)),
      kv('Tracked since', r.listed_at || 'unreported'),
      kv('Age with no token', fmtAge(r.age_days)),
      kv('Token', 'none recorded — no market cap, no CoinGecko id, no symbol'));

    var working = h('div', { class: 'card' },
      h('h3', { text: 'The valuation, worked' }),
      h('div', { class: 'eq' },
        'TVL ', h('b', { text: fmtUsd(r.tvl_usd) }), h('br'),
        'x multiple ', h('b', { text: mult.multiple.toFixed(4) + 'x' }),
        ' (' + (mult.basis === 'category' ? 'median of ' + mult.samples + ' traded ' + (r.category || '') + ' protocols' : 'global median of ' + DATA.multiples.global_samples + ' traded protocols') + ')', h('br'),
        'x momentum ', h('b', { text: v.momentum.toFixed(4) }), ' (7d change ' + fmtPct(r.change_7d) + ', clamped and halved)', h('br'),
        'x seasoning ', h('b', { text: v.seasoning.toFixed(4) }), ' (' + fmtAge(r.age_days) + ' with no token)', h('br'),
        'x breadth ', h('b', { text: v.breadth.toFixed(4) }), ' (' + r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains') + ')', h('br'),
        '= implied launch value ', h('b', { class: 'result', text: fmtUsd(r.implied_value_usd) })),
      h('p', { class: 'check', text: v.value === r.implied_value_usd
        ? 'This page recomputed the value from the figures above and it matches board.json to the dollar.'
        : 'Note: this page\'s recomputation differs from board.json; board.json governs.' }));

    var readiness = h('div', { class: 'card' },
      h('h3', { text: 'Launch readiness' }),
      h('div', { class: 'ready' }, h('span', { class: 'bar' }, h('i', { style: 'width:' + r.readiness + '%' })), h('span', { class: 'n', text: r.readiness + ' / 100' })),
      h('p', { class: 'note', text: 'A reader\'s gauge only — size, momentum, track record and breadth blended. It never moves a rank; ranks come from implied value alone.' }),
      kv('Implied value per $1 of TVL', fmtMult(r.implied_value_usd / r.tvl_usd)),
      kv('Board rank by value', '#' + r.rank + ' of ' + DATA.rows.length));

    app.appendChild(h('div', { class: 'detail-grid' }, record, working, readiness));
    app.appendChild(h('h2', { text: 'How to farm it', style: 'font-size:19px;margin:6px 0 12px' }));
    app.appendChild(h('div', { class: 'plan' },
      r.farm_steps.map(function (s) { return h('div', { class: 'step' }, h('span', { text: s })); })));
    app.appendChild(h('p', { class: 'note', text: 'The plan is generated from this protocol\'s own record — its category picks the action, its main chain the gas, its TVL the capital tier, its age the holding window. It is a plan for positioning before a launch, not a promise that one comes: the record says no token is recorded, never that none exists.' }));
  }

  // ---------- render root ----------
  function render() {
    app.setAttribute('aria-busy', 'true');
    app.textContent = '';
    tableHost = null;
    if (view.name === 'detail') renderDetail(view.slug);
    else renderBoard();
    app.setAttribute('aria-busy', 'false');
    window.scrollTo(0, 0);
  }

  document.getElementById('mastMeta').appendChild(
    h('div', null, 'snapshot ', h('b', { text: DATA.as_of }), h('br'), DATA.source));
  document.getElementById('foot').appendChild(
    h('div', null,
      'Launch Radar · model ', h('span', { class: 'mono', text: DATA.model_name + ' ' + DATA.model_version }),
      ' · Implied values are this board\'s own claims about a hypothetical launch, derived only from the snapshot\'s figures — not predictions, and not anyone else\'s.'));

  window.addEventListener('hashchange', function () { parseHash(); render(); });
  parseHash();
  render();
})();
