'use strict';

/* ==========================================================================
   KPTV — клиент для Smart TV (основа — утверждённый макет preview/).
   Данные — реальные, через BFF /api/v1 (js/api.js).
   Управление: стрелки / Enter / Backspace (пульт: keycodes 37-40, 13, 10009/461).
   ========================================================================== */

var api = window.KPTV.api;

/* ------------------------------ Данные ---------------------------------- */

/* Fallback-градиенты для карточек без постера */
var GRADS = [
  ['#173a6b', '#0e8a8a'], ['#3a1c54', '#8a2b5e'], ['#0f4c5c', '#5f6caf'],
  ['#1a1a40', '#e94560'], ['#532407', '#c96f2e'], ['#101820', '#4e6e58'],
  ['#0b0c10', '#5c2018'], ['#232526', '#914a2c'], ['#355c7d', '#c06c84'],
  ['#2c003e', '#907ad6'], ['#14213d', '#fca311'], ['#005f73', '#94d2bd'],
];

var DB = { home: null, titles: new Map() };
var NAV = [
  ['search', 'Поиск'], ['home', 'Главная'], ['movies', 'Фильмы'], ['serials', 'Сериалы'],
  ['collections', 'Подборки'], ['bookmarks', 'Закладки'], ['history', 'История'],
  ['settings', 'Настройки'],
];

/* Экраны с общим верхним меню («браузерные») */
var BROWSE_SCREENS = ['home', 'catalog', 'section', 'collections', 'search', 'bookmarks', 'history', 'settings'];
var SCREEN_CONTENT = {
  home: 'home-content', catalog: 'catalog-content', section: 'section-content',
  collections: 'collections-content', search: 'search-content',
  bookmarks: 'bookmarks-content', history: 'history-content',
  settings: 'settings-content',
};

var TYPE_LABELS = {
  movie: 'Фильм', serial: 'Сериал', documovie: 'Документальный фильм',
  docuserial: 'Документальный сериал', concert: 'Концерт', tvshow: 'ТВ-шоу',
};

/* Свободное место под последним блоком контента (px, в координатах холста) */
var BOTTOM_GAP = 220;

var ROWS = {
  home: [], detail: [], player: [], register: [[]],
  catalog: [], section: [], collections: [], search: [],
  bookmarks: [], history: [], settings: [],
};
var FOCUS = {
  home: { r: 1, c: 0 }, detail: { r: 0, c: 0 }, player: { r: 0, c: 1 },
  register: { r: 0, c: 0 },
  catalog: { r: 1, c: 0 }, section: { r: 1, c: 0 }, collections: { r: 1, c: 0 },
  search: { r: 1, c: 0 }, bookmarks: { r: 1, c: 0 }, history: { r: 1, c: 0 },
  settings: { r: 1, c: 0 },
};

var state = {
  screen: 'home',
  prev: 'home',
  playerPrev: 'home',   // экран, из которого открыли плеер (возврат из плеера)
  section: 'home',      // активный пункт верхнего меню
  lastNavRow: {},       // экран -> строка контента, с которой ушли в верхнее меню
  title: null,          // объект тайтла (detail)
  detailStack: [],      // стек карточек detail → detail («Похожие»)
  season: 0,            // индекс сезона
  episode: 0,           // индекс серии
  playing: false,
  playInfo: null,       // последний ответ /play
  hls: null,
  progressTimer: null,
  subs: 'Выкл',
  popup: null,
  popupIdx: 0,
  modal: null,          // 'bookmarks' — модал выбора папки закладок
  modalIdx: 0,
  query: '',            // строка поиска
  kbLang: 'ru',         // раскладка клавиатуры поиска
  searchResults: null,
  sectionUrl: null,     // API-путь текущей сетки «Смотреть все»
  sectionPage: 0,       // последняя загруженная страница сетки
  sectionHasMore: false,
  sectionLoading: false,
  sectionGrid: null,
  bookmarkFolders: [],
  bookmarkFolder: null, // активная папка
  settings: null,
};

/* ----------------------------- Хелперы ---------------------------------- */

var $ = function (s) { return document.querySelector(s); };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fnum(v) {
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function grad(t, a) {
  return 'linear-gradient(' + (a == null ? 160 : a) + 'deg, ' + t.grad[0] + ', ' + t.grad[1] + ')';
}

function bgArt(t, angle) {
  if (t.backdrop) return 'url(&quot;' + esc(t.backdrop) + '&quot;) center/cover, ' + grad(t, angle);
  if (t.poster) return 'url(&quot;' + esc(t.poster) + '&quot;) center/cover, ' + grad(t, angle);
  return grad(t, angle);
}

function byId(id) { return DB.titles.get(Number(id)); }

function isSerial(t) {
  return t.type === 'serial' || t.type === 'docuserial' || t.type === 'tvshow';
}

function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var mm = h ? pad(m) : String(m);
  return (h ? h + ':' : '') + mm + ':' + pad(s);
}

/* Unix timestamp (KinoPub dates are in seconds) → dd.mm.yyyy */
function fmtTs(ts) {
  var n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  var d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  function pad(x) { return (x < 10 ? '0' : '') + x; }
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
}

function kpClass(kp) {
  if (kp == null) return '';
  return kp >= 7.5 ? 'good' : kp >= 6 ? 'mid' : 'low';
}

function kpBadge(t) {
  var parts = [];
  if (t.kp != null) parts.push('<span class="rate kp ' + kpClass(t.kp) + '">' + t.kp.toFixed(1) + '</span>');
  if (t.imdb != null) parts.push('<span class="rate imdb">IMDb ' + t.imdb.toFixed(1) + '</span>');
  return parts.join('');
}

function typeLabel(t) { return TYPE_LABELS[t.type] || t.type || ''; }

var toastTimer = null;
function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
}

/* ------------------------ Адаптеры API → модель -------------------------- */

function adaptCard(c) {
  return {
    id: Number(c.id),
    name: c.title,
    type: c.type,
    year: c.year || null,
    kp: fnum(c.kinopoisk_rating),
    imdb: fnum(c.imdb_rating),
    q4k: !!c.is_4k,
    poster: c.poster || null,
    backdrop: c.backdrop || null,
    progressPct: c.progress || 0,
    subtitle: c.subtitle || '',
    media: c.media || null,
    watched: !!c.watched,
    newEpisodes: c.new_episodes || null,
    grad: GRADS[Number(c.id) % GRADS.length],
    detail: false,
  };
}

function remember(c) {
  var existing = DB.titles.get(c.id);
  if (existing) {
    Object.keys(c).forEach(function (k) { existing[k] = c[k]; });
    return existing;
  }
  DB.titles.set(c.id, c);
  return c;
}

async function loadDetail(id) {
  var d = await api('/items/' + id);
  var t = remember(adaptCard(d));
  t.detail = true;
  t.desc = d.plot || '';
  t.cast = d.cast ? d.cast.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
  t.subscribed = !!d.subscribed;
  t.bookmarks = d.bookmarks || [];
  t.folders = d.bookmark_folders || [];
  t.seasons = (d.seasons || []).map(function (s) {
    return {
      n: s.n,
      episodes: (s.episodes || []).map(function (e) {
        return {
          n: e.n, title: e.title || '', duration: e.duration || 0,
          watched: !!e.watched, thumbnail: e.thumbnail || null,
          progress: e.progress || 0,
        };
      }),
    };
  });
  t.videos = (d.videos || []).map(function (v) {
    return { n: v.number, title: v.title || '', watched: !!v.watched, progress: v.progress || 0 };
  });
  t.similar = (d.similar || []).map(function (s) { return remember(adaptCard(s)); });
  return t;
}

/* --------------------------- Карточки/рельсы ----------------------------- */

function posterCard(t) {
  var c = el('div', 'card focusable');
  c.dataset.kind = 'title';
  c.dataset.id = t.id;
  c.innerHTML =
    '<div class="poster-art" style="background:' + bgArt(t) + '">' +
    (t.q4k ? '<div class="badge4k">4K</div>' : '') +
    (t.newEpisodes ? '<div class="badge-new">' + t.newEpisodes + ' нов.</div>' : '') +
    '</div>' +
    '<div class="card-title">' + esc(t.name) + '</div>' +
    '<div class="card-sub">' + (t.year || '') + (t.kp != null ? ' · ★ <b>' + t.kp.toFixed(1) + '</b>' : '') + '</div>';
  return c;
}

function continueCard(t) {
  var c = el('div', 'card focusable');
  c.dataset.kind = 'watch';
  c.dataset.id = t.id;
  c.innerHTML =
    '<div class="cw-art" style="background:' + bgArt(t, 140) + '">' +
    '<div class="cw-shade"></div>' +
    '<div class="cw-play">▶</div>' +
    '<div class="cw-name">' + esc(t.name) + '</div>' +
    '<div class="cw-progress"><i style="width:' + t.progressPct + '%"></i></div>' +
    '</div>' +
    '<div class="card-sub">' + esc(t.subtitle || 'Продолжить просмотр') + '</div>';
  return c;
}

function collectionCard(col) {
  var c = el('div', 'card focusable');
  c.dataset.kind = 'collection';
  c.dataset.id = col.id;
  c.dataset.name = col.title;
  c.innerHTML =
    '<div class="col-art"' + (col.poster ? ' style="background-image:url(&quot;' + esc(col.poster) + '&quot;)"' : '') + '>' +
    '<div class="col-shade"></div>' +
    '<div class="col-name">' + esc(col.title) + '</div>' +
    '</div>';
  return c;
}

/* Последняя карточка ленты — переход в полную сетку раздела */
function allCard(title, url) {
  var c = el('div', 'card focusable card-all');
  c.dataset.kind = 'all';
  c.dataset.title = title;
  c.dataset.url = url;
  c.innerHTML =
    '<div class="poster-art all-art"><span class="all-arrow">→</span></div>' +
    '<div class="card-title">Смотреть все</div>';
  return c;
}

function rail(title, cards, cls) {
  var r = el('section', 'rail vrow' + (cls ? ' ' + cls : ''));
  r.appendChild(el('h2', null, esc(title)));
  var track = el('div', 'track');
  cards.forEach(function (c) { track.appendChild(c); });
  r.appendChild(track);
  return r;
}

/* ------------------------------- Главная -------------------------------- */

function renderNav() {
  var nav = $('#topnav');
  nav.innerHTML = '<div class="nav-logo"><b>KPTV</b></div>';
  NAV.forEach(function (pair) {
    var id = pair[0], label = pair[1];
    var item = el('div', 'nav-item focusable' + (id === state.section ? ' current' : ''), esc(label));
    item.dataset.nav = id;
    nav.appendChild(item);
  });
}

function markNavCurrent() {
  Array.prototype.forEach.call(
    document.querySelectorAll('#topnav .nav-item'),
    function (item) {
      item.classList.toggle('current', item.dataset.nav === state.section);
    }
  );
}

/* Строка 0 у браузерных экранов — общее верхнее меню */
function topRow() {
  return Array.prototype.slice.call(document.querySelectorAll('#topnav .focusable'));
}

function renderHome() {
  renderNav();
  var c = $('#home-content');
  c.innerHTML = '';
  c.style.transform = 'translateY(0)';

  var rails = (DB.home && DB.home.rails) || [];
  var railById = {};
  rails.forEach(function (r) { railById[r.id] = r; });

  var featured = null;
  var freshItems = (railById.fresh || {}).items || [];
  featured = freshItems.map(adaptCard).find(function (t) { return t.backdrop; })
    || (freshItems[0] && adaptCard(freshItems[0]))
    || null;
  if (featured) remember(featured);

  if (featured) {
    var f = featured;
    var hero = el('section', 'hero vrow');
    hero.innerHTML =
      '<div class="hero-bg" style="background:' + bgArt(f, 115) + '"></div>' +
      '<div class="hero-fade"></div>' +
      '<div class="hero-info">' +
      '<div class="hero-tag">' + esc(typeLabel(f)) + '</div>' +
      '<h1>' + esc(f.name) + '</h1>' +
      '<div class="meta">' + kpBadge(f) +
      (f.year ? '<span>' + f.year + '</span>' : '') +
      (f.q4k ? '<span class="uhd">4K</span>' : '') +
      '</div>' +
      '<div class="hero-btns">' +
      '<button class="btn primary focusable" data-act="watch">▶ Смотреть</button>' +
      '<button class="btn focusable" data-act="more">Подробнее</button>' +
      '</div>' +
      '</div>';
    c.appendChild(hero);
  }

  rails.forEach(function (r) {
    if (r.id === 'continue') {
      var items = r.items.map(adaptCard).filter(function (t) { return t.progressPct > 0; });
      items.forEach(remember);
      if (items.length) c.appendChild(rail('Продолжить просмотр', items.map(continueCard)));
    } else {
      var cards = r.items.map(adaptCard);
      cards.forEach(remember);
      if (cards.length) c.appendChild(rail(r.title, cards.map(posterCard)));
    }
  });

  if (!c.children.length) {
    c.appendChild(el('div', 'rail', '<h2>KPTV</h2><div class="card-sub" style="margin-left:4px">Пока пусто — начните смотреть, чтобы здесь появился контент.</div>'));
  }

  buildHomeRows();
}

function buildHomeRows() {
  ROWS.home = [
    topRow(),
    Array.prototype.slice.call(document.querySelectorAll('.hero-btns .btn')),
  ];
  Array.prototype.forEach.call(
    document.querySelectorAll('#home-content .rail'),
    function (r) {
      ROWS.home.push(Array.prototype.slice.call(r.querySelectorAll('.card')));
    }
  );
}

/* Построение строк для экранов-разделов: верхнее меню + все фокусные строки
   контента в DOM-порядке (клавиатура, табы, сетки, рельсы, настройки) */
function buildBrowseRows(screen) {
  var root = '#' + SCREEN_CONTENT[screen];
  var rows = [topRow()];
  Array.prototype.forEach.call(
    document.querySelectorAll(root + ' .kb-row, ' + root + ' .tabs, ' +
      root + ' .grid, ' + root + ' .set-rows, ' + root + ' .rail'),
    function (block) {
      if (block.classList.contains('kb-row')) {
        rows.push(Array.prototype.slice.call(block.querySelectorAll('.focusable')));
      } else if (block.classList.contains('tabs')) {
        var tabs = Array.prototype.slice.call(block.querySelectorAll('.tab'));
        if (tabs.length) rows.push(tabs);
      } else if (block.classList.contains('set-rows')) {
        Array.prototype.forEach.call(block.children, function (row) { rows.push([row]); });
      } else if (block.classList.contains('rail')) {
        var cards = Array.prototype.slice.call(block.querySelectorAll('.card'));
        if (cards.length) rows.push(cards);
      } else {
        /* сетка: группируем карточки в строки по вертикальной позиции */
        var line = [], lineTop = null;
        Array.prototype.forEach.call(block.children, function (card) {
          var top = card.offsetTop;
          if (lineTop === null || Math.abs(top - lineTop) > 4) {
            if (line.length) rows.push(line);
            line = []; lineTop = top;
          }
          line.push(card);
        });
        if (line.length) rows.push(line);
      }
    }
  );
  ROWS[screen] = rows;
}

/* Пересборка строк фокуса после асинхронной отрисовки контента.
   Работает только на видимом экране: у скрытого (display:none) все offsetTop
   равны 0, и сетка собралась бы в одну строку. При keepFocus фокус следует
   за самим элементом (а не за индексом строки): если над ним появились
   новые строки, фокус остаётся на месте, а не «отбрасывает назад» */
function rebuildRows(screen, keepFocus) {
  if (state.screen !== screen) return;
  var oldRows = ROWS[screen] || [];
  var f = FOCUS[screen];
  var focusedEl = null;
  if (keepFocus && f && oldRows[f.r]) focusedEl = oldRows[f.r][f.c] || null;
  if (screen === 'home') buildHomeRows(); else buildBrowseRows(screen);
  var rows = ROWS[screen];
  if (focusedEl) {
    var pos = locate(rows, focusedEl);
    if (pos) {
      FOCUS[screen] = pos;
      markNavCurrent();
      applyFocus();
      return;
    }
  }
  if (rows.length > 1) FOCUS[screen] = { r: 1, c: 0 };
  markNavCurrent();
  applyFocus();
}

/* --------------------------- Детальная страница -------------------------- */

function epCard(t, e) {
  var c = el('div', 'card ep focusable');
  c.dataset.s = state.season;
  c.dataset.e = e.n - 1;
  c.innerHTML =
    '<div class="ep-art"' + (e.thumbnail ? ' style="background-image:url(&quot;' + esc(e.thumbnail) + '&quot;)"' : ' style="background:' + grad(t, 200) + '"') + '>' +
    '<span class="ep-num">' + e.n + '</span>' +
    (e.watched ? '<span class="ep-done">✓</span>' : '') +
    '</div>' +
    '<div class="card-title">' + e.n + '. ' + esc(e.title || 'Серия ' + e.n) + '</div>' +
    '<div class="card-sub">' + (e.duration ? fmtTime(e.duration) : '') + '</div>';
  if (e.progress > 0 && e.progress < 100) {
    c.querySelector('.ep-art').appendChild(
      el('div', 'poster-progress', '<i style="width:' + e.progress + '%"></i>')
    );
  }
  return c;
}

function renderDetail() {
  var t = state.title;
  var s = $('#screen-detail');
  s.innerHTML =
    '<div class="detail-backdrop" style="background:' + bgArt(t, 120) + '"></div>' +
    '<div class="detail-fade"></div>' +
    '<div id="detail-scroll"><div id="detail-content" class="scroll-content"></div></div>';
  var c = $('#detail-content');

  var main = el('section', 'detail-main vrow');
  main.innerHTML =
    '<div class="d-poster" style="background:' + bgArt(t) + '">' + (t.poster ? '' : '<div class="poster-name">' + esc(t.name) + '</div>') + '</div>' +
    '<div class="d-info">' +
    '<h1>' + esc(t.name) + '</h1>' +
    '<div class="meta">' + kpBadge(t) +
    (t.year ? '<span>' + t.year + '</span>' : '') +
    '<span>' + esc(typeLabel(t)) + '</span>' +
    (t.q4k ? '<span class="uhd">4K</span>' : '') +
    '</div>' +
    '<div class="d-btns">' +
    '<button class="btn primary focusable" data-act="watch">▶ Смотреть</button>' +
    '<button class="btn focusable' + (t.subscribed ? ' on' : '') + '" data-act="later"><span class="b-txt">' + (t.subscribed ? '✓ Буду смотреть' : 'Буду смотреть') + '</span></button>' +
    '<button class="btn focusable' + (t.bookmarks.length ? ' on' : '') + '" data-act="bookmark"><span class="b-txt">' + (t.bookmarks.length ? '✓ В закладках' : 'В закладки') + '</span></button>' +
    '</div>' +
    (t.desc ? '<p class="d-desc">' + esc(t.desc) + '</p>' : '') +
    (t.cast.length ? '<div class="d-cast"><span class="cast-label">В ролях:</span>' + t.cast.map(function (a) { return '<span class="actor">' + esc(a) + '</span>'; }).join('') + '</div>' : '') +
    '</div>';
  c.appendChild(main);

  if (isSerial(t) && t.seasons && t.seasons.length) {
    var sec = el('section', 'rail d-seasons vrow');
    var tabs = el('div', 'tabs');
    t.seasons.forEach(function (se, i) {
      var tab = el('div', 'tab focusable' + (i === state.season ? ' active' : ''), 'Сезон ' + se.n);
      tab.dataset.season = i;
      tabs.appendChild(tab);
    });
    sec.appendChild(tabs);
    var track = el('div', 'track');
    t.seasons[state.season].episodes.forEach(function (e) { track.appendChild(epCard(t, e)); });
    sec.appendChild(track);
    c.appendChild(sec);
  }

  if (t.videos && t.videos.length > 1 && !(isSerial(t) && t.seasons && t.seasons.length)) {
    var vsec = el('section', 'rail vrow');
    vsec.appendChild(el('h2', null, 'Версии'));
    var vtrack = el('div', 'track');
    t.videos.forEach(function (v, i) {
      var card = el('div', 'card ep focusable');
      card.dataset.v = i;
      card.innerHTML =
        '<div class="ep-art" style="background:' + grad(t, 200) + '"><span class="ep-num">' + v.n + '</span>' + (v.watched ? '<span class="ep-done">✓</span>' : '') + '</div>' +
        '<div class="card-title">' + v.n + '. ' + esc(v.title || 'Версия ' + v.n) + '</div>';
      if (v.progress > 0 && v.progress < 100) {
        card.querySelector('.ep-art').appendChild(
          el('div', 'poster-progress', '<i style="width:' + v.progress + '%"></i>')
        );
      }
      vtrack.appendChild(card);
    });
    vsec.appendChild(vtrack);
    c.appendChild(vsec);
  }

  if (t.similar && t.similar.length) {
    c.appendChild(rail('Похожие', t.similar.map(posterCard), 'similar'));
  }

  buildDetailRows();
}

function buildDetailRows() {
  var rows = [];
  rows.push(Array.prototype.slice.call(document.querySelectorAll('#detail-content .d-btns .btn')));
  var t = state.title;
  if (isSerial(t) && t.seasons && t.seasons.length) {
    rows.push(Array.prototype.slice.call(document.querySelectorAll('#detail-content .tab')));
    rows.push(Array.prototype.slice.call(document.querySelectorAll('.d-seasons .card')));
  }
  if (t.videos && t.videos.length > 1 && !(isSerial(t) && t.seasons && t.seasons.length)) {
    rows.push(Array.prototype.slice.call(document.querySelectorAll('#detail-content .vrow .card')));
  }
  if (t.similar && t.similar.length) {
    rows.push(Array.prototype.slice.call(document.querySelectorAll('#detail-content .similar .card')));
  }
  ROWS.detail = rows;
}

function seasonSelect(i) {
  state.season = i;
  renderDetail();
  FOCUS.detail = { r: 1, c: i };
  applyFocus();
}

/* -------------------------------- Плеер ---------------------------------- */

var PICON = {
  play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  rew: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>',
  subs: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>',
  quality: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1h-4V9zm1.5 4.5h2v-3h-2v3z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>',
};

/* Транспорт (перемотка/пауза/серии) — по центру; для сериалов добавляем
   переходы между сериями, для фильмов их нет. Субтитры/дорожка/качество —
   отдельной группой справа */
var TRANSPORT_MOVIE = [['rew', '10'], ['play', ''], ['fwd', '10']];
var TRANSPORT_SERIAL = [['prev', ''], ['rew', '10'], ['play', ''], ['fwd', '10'], ['next', '']];
var SIDE_CONTROLS = [['subs', 'Субтитры'], ['audio', 'Аудио'], ['quality', 'Качество']];

function makePbtn(id, label) {
  var b = el('button', 'pbtn focusable pbtn-' + id);
  b.dataset.c = id;
  if (id === 'play') {
    b.innerHTML =
      '<span class="pi pi-play">' + PICON.play + '</span>' +
      '<span class="pi pi-pause hidden">' + PICON.pause + '</span>';
  } else {
    b.innerHTML = PICON[id] + '<span class="pbtn-label">' + esc(label) + '</span>';
  }
  return b;
}

function buildPlayer() {
  var bar = $('#player-controls');
  bar.innerHTML = '';
  var controls = (state.title && isSerial(state.title)) ? TRANSPORT_SERIAL : TRANSPORT_MOVIE;
  controls.forEach(function (pair) { bar.appendChild(makePbtn(pair[0], pair[1])); });
  var side = el('div', 'pbtn-side');
  SIDE_CONTROLS.forEach(function (pair) { side.appendChild(makePbtn(pair[0], pair[1])); });
  bar.appendChild(side);
  ROWS.player = [Array.prototype.slice.call(bar.querySelectorAll('.pbtn'))];
  /* play — по центру группы */
  FOCUS.player.c = controls.length === TRANSPORT_SERIAL.length ? 2 : 1;
}

function setCtl(id, txt) {
  var b = document.querySelector('.pbtn[data-c="' + id + '"]');
  var label = b && b.querySelector('.pbtn-label');
  if (label) label.textContent = txt;
}

function playerVideo() { return $('#pv-video'); }

function stopPlayback() {
  state.playing = false;
  clearInterval(state.progressTimer);
  state.progressTimer = null;
  if (state.hls) {
    try { state.hls.destroy(); } catch (e) {}
    state.hls = null;
  }
  var video = playerVideo();
  video.pause();
  Array.prototype.forEach.call(video.querySelectorAll('track'), function (t) { t.remove(); });
}

function seekBy(delta) {
  var video = playerVideo();
  video.currentTime = Math.max(0, video.currentTime + delta);
  updateProgress();
}

function togglePlay() {
  var video = playerVideo();
  if (video.paused) { video.play(); } else { video.pause(); }
}

function updatePlayerUI() {
  var t = state.title;
  var info = state.playInfo;
  $('#pv-title').textContent = info.title || (t && t.name) || '';
  if (info.season != null) {
    $('#pv-ep').textContent = 'Сезон ' + info.season + ' · Серия ' + info.episode;
  } else if (t) {
    $('#pv-ep').textContent = [t.year, typeLabel(t)].filter(Boolean).join(' · ');
  } else if (info.live) {
    $('#pv-ep').textContent = 'Прямой эфир';
  } else {
    $('#pv-ep').textContent = '';
  }
  $('#pp-total').textContent = info.live ? 'LIVE' : fmtTime(info.duration);
  updateProgress();
}

function updateProgress() {
  var video = playerVideo();
  var live = state.playInfo && state.playInfo.live;
  var duration = live ? 0 : (video.duration || (state.playInfo && state.playInfo.duration) || 0);
  var time = video.currentTime || 0;
  $('#pp-fill').style.width = (duration ? (time / duration) * 100 : 0) + '%';
  $('#pp-cur').textContent = live ? 'LIVE' : fmtTime(time);
}

function updateControlLabels() {
  var video = playerVideo();
  var live = state.playInfo && state.playInfo.live;
  var playBtn = document.querySelector('.pbtn-play');
  if (playBtn) {
    playBtn.querySelector('.pi-play').classList.toggle('hidden', state.playing);
    playBtn.querySelector('.pi-pause').classList.toggle('hidden', !state.playing);
  }
  var hasNext = !live && state.title && isSerial(state.title) && nextEpisodeIndex() != null;
  var nextBtn = document.querySelector('.pbtn-next');
  if (nextBtn) nextBtn.classList.toggle('dim', !hasNext);
  var hasPrev = !live && state.title && isSerial(state.title) && prevEpisodeIndex() != null;
  var prevBtn = document.querySelector('.pbtn-prev');
  if (prevBtn) prevBtn.classList.toggle('dim', !hasPrev);
  setCtl('subs', 'Субтитры · ' + state.subs);
  $('#player-paused').classList.toggle('hidden', state.playing || video.readyState === 0);
}

/* Попапы аудио/субтитров/качества строятся из реальных дорожек плеера */

function popupConfig(kind) {
  if (kind === 'subs') {
    var items = ['Выкл'].concat((state.playInfo.subtitles || []).map(function (t) { return t.label; }));
    return { title: 'Субтитры', items: items, current: state.subs };
  }
  if (kind === 'audio') {
    var tracks = state.hls && state.hls.audioTracks ? state.hls.audioTracks : [];
    if (!tracks.length) return { title: 'Аудиодорожка', items: ['По умолчанию'], current: 'По умолчанию' };
    var names = tracks.map(function (tr, i) { return tr.name || ('Дорожка ' + (i + 1)); });
    var cur = tracks[state.hls.audioTrack] ? (tracks[state.hls.audioTrack].name || names[state.hls.audioTrack]) : names[0];
    return { title: 'Аудиодорожка', items: names, current: cur };
  }
  if (kind === 'quality') {
    if (!state.hls || !state.hls.levels || !state.hls.levels.length) {
      return { title: 'Качество', items: ['Авто'], current: 'Авто' };
    }
    var heights = [];
    state.hls.levels.forEach(function (lv) {
      if (lv.height && heights.indexOf(lv.height) < 0) heights.push(lv.height);
    });
    heights.sort(function (a, b) { return b - a; });
    var qlabels = ['Авто'].concat(heights.map(function (h) { return h + 'p'; }));
    var current = 'Авто';
    if (state.hls.currentLevel >= 0 && state.hls.levels[state.hls.currentLevel]) {
      current = state.hls.levels[state.hls.currentLevel].height + 'p';
    }
    return { title: 'Качество', items: qlabels, current: current };
  }
  return null;
}

function openPopup(kind) {
  state.popup = kind;
  var cfg = popupConfig(kind);
  state.popupIdx = Math.max(0, cfg.items.indexOf(cfg.current));
  renderPopup();
}

function renderPopup() {
  var cfg = popupConfig(state.popup);
  if (!cfg) return;
  var p = $('#player-popup');
  p.innerHTML = '<div class="popup-title">' + esc(cfg.title) + '</div>' + cfg.items.map(function (it, i) {
    return '<div class="popup-item' + (cfg.current === it ? ' sel' : '') + (i === state.popupIdx ? ' cur' : '') + '" data-i="' + i + '">' +
      esc(it) + (cfg.current === it ? ' ✓' : '') + '</div>';
  }).join('');
  p.classList.remove('hidden');
}

function selectPopup(i) {
  var kind = state.popup;
  var cfg = popupConfig(kind);
  var value = cfg.items[i];
  if (kind === 'subs') {
    state.subs = value;
    var video = playerVideo();
    Array.prototype.forEach.call(video.textTracks, function (track, ix) {
      var label = (state.playInfo.subtitles[ix] || {}).label;
      track.mode = (label === value) ? 'showing' : 'hidden';
    });
    toast('Субтитры: ' + value);
  } else if (kind === 'audio') {
    if (state.hls && state.hls.audioTracks && state.hls.audioTracks.length) {
      state.hls.audioTrack = i;
      toast('Аудиодорожка: ' + value);
    } else {
      toast('Переключение недоступно на этом устройстве');
    }
  } else if (kind === 'quality') {
    if (state.hls && state.hls.levels && state.hls.levels.length) {
      if (value === 'Авто') {
        state.hls.currentLevel = -1;
      } else {
        var height = parseInt(value, 10);
        for (var li = 0; li < state.hls.levels.length; li++) {
          if (state.hls.levels[li].height === height) { state.hls.currentLevel = li; break; }
        }
      }
      toast('Качество: ' + value);
    }
  }
  closePopup();
  updateControlLabels();
}

function closePopup() {
  state.popup = null;
  $('#player-popup').classList.add('hidden');
  showOverlay();
}

/* Следующая серия */

function nextEpisodeIndex() {
  var t = state.title;
  if (!t || !isSerial(t) || !t.seasons || !t.seasons.length) return null;
  var s = state.season, e = state.episode + 1;
  if (e >= t.seasons[s].episodes.length) { s++; e = 0; }
  if (s >= t.seasons.length) return null;
  return { s: s, e: e };
}

function nextEpisode() {
  var nxt = nextEpisodeIndex();
  if (!nxt) { toast('Это последняя серия'); return; }
  openPlayer(state.title.id, nxt.s, nxt.e);
  toast('Серия ' + (nxt.e + 1));
}

function prevEpisodeIndex() {
  var t = state.title;
  if (!t || !isSerial(t) || !t.seasons || !t.seasons.length) return null;
  var s = state.season, e = state.episode - 1;
  if (e < 0) {
    s--;
    if (s < 0) return null;
    e = t.seasons[s].episodes.length - 1;
  }
  if (e < 0) return null;
  return { s: s, e: e };
}

function prevEpisode() {
  var prv = prevEpisodeIndex();
  if (!prv) { toast('Это первая серия'); return; }
  openPlayer(state.title.id, prv.s, prv.e);
  toast('Серия ' + (prv.e + 1));
}

/* Запуск воспроизведения */

/* hls.js (~600 КБ) грузим лениво, при первом воспроизведении — не тормозим
   старт приложения на ТВ */
var hlsLoading = null;
function ensureHls() {
  if (window.Hls) return Promise.resolve();
  if (hlsLoading) return hlsLoading;
  hlsLoading = new Promise(function (resolve) {
    var s = document.createElement('script');
    s.src = 'js/hls.min.js';
    s.onload = function () { resolve(); };
    s.onerror = function () { resolve(); /* останется нативный плеер */ };
    document.head.appendChild(s);
  });
  return hlsLoading;
}

function canNativeHls(video) {
  if (!video.canPlayType('application/vnd.apple.mpegurl')) return false;
  var ua = navigator.userAgent;
  /* ТВ-платформы с аппаратным HLS */
  if (/Tizen|webOS|Web0S|NetCast|Smart-TV|SMART-TV|VIDAA/i.test(ua)) return true;
  /* Chrome (в т.ч. десктопный) отвечает на mpegurl «maybe», но HLS через
     <video src> не воспроизводит — MEDIA_ERR_SRC_NOT_SUPPORTED. Нативный
     путь оставляем WebKit/Safari, где он реально работает */
  return /\bSafari\b/.test(ua) && !/Chrome|Chromium/i.test(ua);
}

/* Реальная поддержка HEVC у этого браузера: KinoPub отдаёт HEVC- или
   AVC-манифесты по флагу capability устройства, а настройка hevc в профиле
   отражает возможности ТВ — для просмотра через браузер важно то, что умеет
   сам браузер (иначе «Ошибка воспроизведения» на HEVC-only тайтлах) */
function hevcSupported() {
  var profiles = ['hvc1.1.6.L93.B0', 'hvc1.2.4.L150.B0'];
  for (var i = 0; i < profiles.length; i++) {
    var mime = 'video/mp4; codecs="' + profiles[i] + '"';
    try {
      if (window.MediaSource && MediaSource.isTypeSupported(mime)) return true;
    } catch (e) {}
    try {
      if (document.createElement('video').canPlayType(mime)) return true;
    } catch (e) {}
  }
  return false;
}

async function openPlayer(id, sIdx, eIdx) {
  var t = byId(id);
  if (!t || !t.detail) t = await loadDetail(id);
  /* возврат из плеера — в свой экран; state.prev не трогаем, это точка
     возврата карточки (иначе после просмотра назад из карточки зацикливается) */
  state.playerPrev = state.screen === 'player' ? state.playerPrev : state.screen;
  state.title = t;

  var query = '';
  if (sIdx != null && t.seasons && t.seasons[sIdx]) {
    state.season = sIdx;
    state.episode = eIdx != null ? eIdx : 0;
    query = '?season=' + t.seasons[sIdx].n;
    if (t.seasons[sIdx].episodes[state.episode]) {
      query += '&episode=' + t.seasons[sIdx].episodes[state.episode].n;
    }
  } else {
    state.season = 0;
    state.episode = 0;
    if (eIdx != null && t.videos && t.videos[eIdx]) query = '?episode=' + t.videos[eIdx].n;
  }

  var infoPromise = api('/play/' + id + query +
    (query ? '&' : '?') + 'hevc=' + (hevcSupported() ? 1 : 0));
  var hlsPromise = ensureHls();
  var info = await infoPromise;
  state.playInfo = info;
  state.subs = 'Выкл';
  await hlsPromise;

  startPlayback(info);
  switchScreen('player');
  showOverlay();
}

function startPlayback(info) {
  stopPlayback();

  var video = playerVideo();
  video.textContent = '';
  (info.subtitles || []).forEach(function (track) {
    var t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = track.label;
    t.srclang = track.lang;
    t.src = track.url;
    video.appendChild(t);
  });

  if (canNativeHls(video)) {
    /* нативный HLS: аппаратное декодирование на ТВ, никакого JS-демуксера */
    video.src = info.url;
  } else if (window.Hls && Hls.isSupported()) {
    var hls = new Hls();
    state.hls = hls;
    hls.on(Hls.Events.ERROR, function (e, d) {
      /* понятное сообщение вместо молчаливого отказа: почти всегда это
         формат, который браузер не может декодировать */
      if (d && d.fatal) toast('Видео в формате, который не поддерживается устройством');
    });
    hls.loadSource(info.url);
    hls.attachMedia(video);
  } else {
    video.src = info.url;
  }

  buildPlayer();

  if (info.position) {
    var onMeta = function () {
      video.removeEventListener('loadedmetadata', onMeta);
      if (video.currentTime < info.position - 5) video.currentTime = info.position;
    };
    video.addEventListener('loadedmetadata', onMeta);
  }

  state.playing = true;
  var playPromise = video.play();
  if (playPromise && playPromise.catch) { playPromise.catch(function () { /* autoplay policies */ }); }

  clearInterval(state.progressTimer);
  state.progressTimer = null;
  if (info.content_id) state.progressTimer = setInterval(reportProgress, 10000);
  updatePlayerUI();
  updateControlLabels();
}

function reportProgress() {
  var video = playerVideo();
  var info = state.playInfo;
  if (!info || !info.content_id || !video.currentTime) return;
  api('/progress', {
    method: 'POST',
    body: {
      id: info.content_id,
      time: Math.floor(video.currentTime),
      season: info.season,
      episode: info.episode,
    },
  }).catch(function () { /* best-effort */ });
}

function activateControl(id) {
  if (id === 'rew') seekBy(-10);
  else if (id === 'fwd') seekBy(10);
  else if (id === 'play') togglePlay();
  else if (id === 'next') nextEpisode();
  else if (id === 'prev') prevEpisode();
  else openPopup(id);
  updateProgress();
}

var hideTimer = null;
function showOverlay() {
  $('#player-overlay').classList.add('visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(function () {
    if (!state.popup) $('#player-overlay').classList.remove('visible');
  }, 3500);
}

/* --------------------------- Навигация и фокус --------------------------- */

function offsetTopIn(node, stop) {
  var y = 0;
  while (node && node !== stop) { y += node.offsetTop; node = node.offsetParent; }
  return y;
}

function applyFocus() {
  var scr = state.screen;
  var rows = ROWS[scr], f = FOCUS[scr];
  var screenEl = $('#screen-' + scr);
  /* очищаем по всему холсту: #topnav лежит вне экранных секций */
  var prevFocused = $('#stage').querySelectorAll('.focused');
  for (var pi = 0; pi < prevFocused.length; pi++) { prevFocused[pi].classList.remove('focused'); }
  var row = rows[f.r];
  if (!row || !row.length) return;
  f.c = Math.max(0, Math.min(f.c, row.length - 1));
  var elm = row[f.c];
  elm.classList.add('focused');
  if (scr === 'player' || scr === 'register') return;

  var scrollY = 0;
  var content = screenEl.querySelector('.scroll-content');
  if (content) {
    var vrow = elm.closest('.vrow');
    var host = vrow || elm;
    var top = offsetTopIn(host, content);
    var h = host.offsetHeight;
    /* скроллим минимально: только когда фокус уходит за край видимой зоны,
       иначе страница «дергается» на каждом нажатии. Сравниваем с высотой
       блока целиком — иначе высокие ряды обрезаются снизу. Низ контента
       меряем по последнему ребёнку, а не по scrollHeight: Firefox и часть
       ТВ-движков не включают padding-bottom в scrollHeight */
    var last = content.lastElementChild;
    var yMax = 0;
    if (last) {
      yMax = Math.max(0, offsetTopIn(last, content) + last.offsetHeight + BOTTOM_GAP - 1080);
    }
    var m = /translateY\((-?\d+)px\)/.exec(content.style.transform || '');
    var y = m ? -parseInt(m[1], 10) : 0;
    if (top < y + 130) y = Math.max(0, top - 240);
    else if (top + h > y + 1080 - BOTTOM_GAP) y = Math.min(top + h - 1080 + BOTTOM_GAP, yMax);
    y = Math.max(0, Math.min(y, yMax));
    content.style.transform = 'translateY(' + (-y) + 'px)';
    scrollY = y;
  }
  var track = elm.closest('.track');
  if (track) {
    /* то же самое по горизонтали: лента сдвигается только когда карточка
       выходит за правый/левый край */
    var max = Math.max(0, track.scrollWidth - 1780);
    var tm = /translateX\((-?\d+)px\)/.exec(track.style.transform || '');
    var shift = tm ? -parseInt(tm[1], 10) : 0;
    var left = elm.offsetLeft, w = elm.offsetWidth;
    if (left < shift + 8) shift = Math.max(0, left - 24);
    else if (left + w > shift + 1780 - 8) shift = Math.min(left + w + 24 - 1780, max);
    shift = Math.max(0, Math.min(shift, max));
    track.style.transform = 'translateX(' + (-shift) + 'px)';
  }
  /* верхнее меню уезжает вверх, когда контент прокручен вниз; на самом меню
     (строка 0) оно всегда видимо */
  if (BROWSE_SCREENS.indexOf(scr) >= 0) {
    $('#stage').classList.toggle('nav-hidden', scrollY > 40 && f.r !== 0);
  } else {
    $('#stage').classList.remove('nav-hidden');
  }
  /* сетка «Смотреть все»: на последних строках догружаем следующую страницу */
  if (scr === 'section' && !state.sectionLoading && state.sectionHasMore &&
      f.r >= rows.length - 2) {
    loadSectionPage();
  }
  /* список подборок: такая же догрузка на последних строках */
  if (scr === 'collections' && !collectionsState.current &&
      !collectionsState.loading && collectionsState.hasMore &&
      f.r >= rows.length - 2) {
    loadCollectionsPage();
  }
}

function move(dx, dy) {
  var rows = ROWS[state.screen], f = FOCUS[state.screen];
  if (!rows.length) return;
  if (dy) {
    var r = f.r + dy;
    if (dy > 0 && f.r === 0 && BROWSE_SCREENS.indexOf(state.screen) >= 0) {
      /* из верхнего меню ↓ возвращает туда, откуда пришли (на этом экране) */
      r = Math.min(state.lastNavRow[state.screen] || 1, rows.length - 1);
    }
    if (r >= rows.length) return;
    if (r < 0) return;
    var browse = BROWSE_SCREENS.indexOf(state.screen) >= 0;
    if (r === 0 && browse) {
      /* строка 0 — верхнее меню: запоминаем, откуда пришли, и встаём на
         пункт текущего раздела */
      state.lastNavRow[state.screen] = f.r;
      f.r = r;
      f.c = 0;
      for (var k = 0; k < rows[0].length; k++) {
        if (rows[0][k].dataset.nav === state.section) { f.c = k; break; }
      }
    } else {
      /* ленты: смена строки — с первой карточки; сетки, табы и кнопки —
         стандартные правила, колонка сохраняется */
      var newRow = rows[r];
      var isRail = newRow.length && newRow[0].closest('.track');
      f.r = r;
      f.c = isRail ? 0 : Math.min(f.c, newRow.length - 1);
    }
  } else if (dx) {
    var c = f.c + dx;
    if (c < 0 || c >= rows[f.r].length) return;
    f.c = c;
  }
  applyFocus();
}

function switchScreen(name) {
  var screens = document.querySelectorAll('.screen');
  for (var si = 0; si < screens.length; si++) { screens[si].classList.add('hidden'); }
  $('#screen-' + name).classList.remove('hidden');
  $('#stage').classList.toggle('chrome-hidden', BROWSE_SCREENS.indexOf(name) < 0);
  /* на свежем экране меню видимо; applyFocus ниже скроет его, если контент
     уже прокручен */
  $('#stage').classList.remove('nav-hidden');
  state.screen = name;
  /* контент мог дорисоваться, пока экран был скрыт (у скрытых экранов все
     offsetTop равны 0) — пересобираем строки фокуса по актуальному DOM */
  if (BROWSE_SCREENS.indexOf(name) >= 0) {
    var content = document.getElementById(SCREEN_CONTENT[name]);
    if (content && content.children.length) {
      if (name === 'home') buildHomeRows(); else buildBrowseRows(name);
      var rows = ROWS[name], f = FOCUS[name];
      if (rows.length) {
        f.r = Math.min(f.r, rows.length - 1);
        f.c = Math.min(f.c, rows[f.r].length - 1);
      }
    }
  }
  markNavCurrent();
  applyFocus();
}

async function openDetail(id) {
  var t = byId(id);
  if (!t || !t.detail) t = await loadDetail(id);
  if (state.screen === 'detail' && state.title && state.title.id !== t.id) {
    /* переход карточка → карточка («Похожие»): запоминаем, откуда пришли,
       чтобы Back вернул на предыдущую карточку, а не застрял */
    state.detailStack.push({
      title: state.title,
      season: state.season,
      focus: { r: FOCUS.detail.r, c: FOCUS.detail.c },
    });
    if (state.detailStack.length > 10) state.detailStack.shift();
  } else if (state.screen !== 'detail') {
    state.detailStack = [];
    state.prev = state.screen;
  }
  state.title = t;
  state.season = 0;
  renderDetail();
  FOCUS.detail = { r: 0, c: 0 };
  switchScreen('detail');
}

function goBack() {
  if (state.screen === 'register') return;
  if (state.screen === 'home') {
    /* на главной Backspace из верхнего меню уходит в контент */
    if (FOCUS.home.r === 0) { FOCUS.home.r = state.lastNavRow.home || 1; applyFocus(); }
    return;
  }
  if (state.screen === 'player') {
    stopPlayback();
    switchScreen(state.playerPrev === 'player' ? 'home' : state.playerPrev);
  } else if (state.screen === 'detail' && state.detailStack.length) {
    /* возврат по цепочке карточек: восстанавливаем предыдущую */
    var d = state.detailStack.pop();
    state.title = d.title;
    state.season = d.season;
    renderDetail();
    FOCUS.detail = d.focus;
    switchScreen('detail');
  } else if (state.screen === 'section') {
    /* из сетки «Смотреть все» — обратно в каталог (открывается только оттуда) */
    switchScreen('catalog');
  } else if (state.screen === 'collections' && collectionsState.current) {
    /* из открытой подборки — обратно к списку подборок */
    openCollections();
  } else if (BROWSE_SCREENS.indexOf(state.screen) >= 0) {
    openSection('home');
  } else {
    switchScreen(state.prev && state.prev !== 'player' ? state.prev : 'home');
  }
}

/* ------------------------------ Разделы меню ----------------------------- */

var SECTION_RENDERED = {};

function openSection(id) {
  state.section = id;
  if (id === 'home') return openHome();
  if (id === 'movies' || id === 'serials') return openCatalog(id === 'movies' ? 'movie' : 'serial');
  if (id === 'collections') return openCollections();
  if (id === 'search') return openSearch();
  if (id === 'bookmarks') return openBookmarks();
  if (id === 'history') return openHistory();
  if (id === 'settings') return openSettings();
  toast('Раздел «' + id + '» — скоро');
}

function openHome() {
  switchScreen('home');
  if (SECTION_RENDERED.home) { markNavCurrent(); return; }
  loadHome();
}

function loadHome() {
  return api('/home')
    .then(function (home) {
      DB.home = home;
      renderHome();
      FEATURED_ID = null;
      var fresh = (home.rails || []).filter(function (r) { return r.id === 'fresh'; })[0];
      var withBackdrop = (fresh && fresh.items || []).map(adaptCard)
        .find(function (t) { return t.backdrop; }) || (fresh && fresh.items[0] && adaptCard(fresh.items[0]));
      if (withBackdrop) {
        remember(withBackdrop);
        FEATURED_ID = withBackdrop.id;
        var hero = document.querySelector('.hero');
        if (hero) hero.dataset.id = FEATURED_ID;
      }
      SECTION_RENDERED.home = true;
      FOCUS.home = { r: Math.min(1, ROWS.home.length - 1), c: 0 };
      markNavCurrent();
      applyFocus();
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { SECTION_RENDERED.home = false; showRegister(); return; }
      toast('Ошибка загрузки: ' + e.message);
    });
}

/* ------------------------------- Каталог --------------------------------- */

/* токен поколения каталога: отсекает поздние ответы от предыдущего
   раздела/подборки, переиспользующих тот же #catalog-content */
var catalogToken = 0;

/* сколько карточек показываем в ленте каталога до «Смотреть все» */
var RAIL_LIMIT = 10;

function openCatalog(type) {
  var token = ++catalogToken;
  switchScreen('catalog');
  if (SECTION_RENDERED['catalog:' + type]) { markNavCurrent(); return; }
  var c = $('#catalog-content');
  c.innerHTML = '';
  ROWS.catalog = [topRow()];
  var loading = el('div', 'page-head', '<div class="sub">Загрузка…</div>');
  c.appendChild(loading);

  /* секции грузятся и рисуются независимо: сбой или зависание одной не
     блокирует остальные (раньше Promise.all ронял весь экран). Слоты —
     чтобы порядок лент не зависел от порядка ответов */
  var pending = 0, made = 0;
  function settle() {
    if (token !== catalogToken) return;
    pending--;
    if (pending > 0) return;
    loading.remove();
    if (!made) {
      /* ничего не загрузилось — даём повторить при следующем заходе */
      delete SECTION_RENDERED['catalog:' + type];
      c.appendChild(el('div', 'page-head',
        '<div class="sub">Не удалось загрузить каталог. Попробуйте позже.</div>'));
    }
  }
  [['Новинки', '/catalog?section=fresh&type=' + type],
   ['Популярное', '/catalog?section=popular&type=' + type],
   ['Весь каталог', '/catalog?type=' + type]
  ].forEach(function (pair) {
    var slot = el('div');
    c.appendChild(slot);
    pending++;
    api(pair[1]).then(function (res) {
      if (token !== catalogToken) return;
      var raw = (res && res.items) || [];
      /* в ленте — несколько карточек, последняя — «Смотреть все» в сетку */
      var items = raw.slice(0, RAIL_LIMIT).map(adaptCard);
      if (!items.length) return;
      items.forEach(remember);
      var cards = items.map(posterCard);
      if (res.has_more || raw.length > RAIL_LIMIT) {
        cards.push(allCard(pair[0], pair[1]));
      }
      slot.appendChild(rail(pair[0], cards));
      made++;
      if (made === 1) loading.remove();
      SECTION_RENDERED['catalog:' + type] = true;
      rebuildRows('catalog', true);
    }, function () {
      /* секция не загрузилась — просто не показываем её */
    }).then(settle);
  });
}

/* --------------------- Сетка раздела («Смотреть все») --------------------- */

var sectionToken = 0;

function openSectionGrid(title, url) {
  var token = ++sectionToken;
  state.sectionUrl = url;
  state.sectionPage = 0;
  state.sectionHasMore = true;
  state.sectionLoading = false;
  switchScreen('section');

  var c = $('#section-content');
  c.innerHTML = '';
  ROWS.section = [topRow()];
  c.appendChild(el('div', 'page-head', '<h1>' + esc(title) + '</h1>'));
  state.sectionGrid = el('div', 'grid');
  c.appendChild(state.sectionGrid);

  loadSectionPage(token);
}

function loadSectionPage(token) {
  if (token == null) token = sectionToken;
  if (state.sectionLoading || !state.sectionHasMore) return;
  state.sectionLoading = true;
  var page = state.sectionPage + 1;
  var sep = state.sectionUrl.indexOf('?') >= 0 ? '&' : '?';
  api(state.sectionUrl + sep + 'page=' + page)
    .then(function (res) {
      if (token !== sectionToken) return;
      state.sectionLoading = false;
      var items = (res.items || []).map(adaptCard);
      items.forEach(remember);
      items.forEach(function (t) { state.sectionGrid.appendChild(posterCard(t)); });
      state.sectionPage = page;
      state.sectionHasMore = !!res.has_more;
      if (!items.length && page === 1) {
        state.sectionGrid.appendChild(el('div', 'card-sub', 'Ничего не нашлось'));
      }
      rebuildRows('section', true);
    })
    .catch(function (e) {
      if (token !== sectionToken) return;
      state.sectionLoading = false;
      if (e && e.code === 'not_registered') { showRegister(); return; }
      if (page > 1) {
        toast('Не удалось загрузить ещё: ' + e.message);
      } else {
        state.sectionGrid.appendChild(el('div', 'card-sub', 'Ошибка загрузки: ' + esc(e.message)));
        rebuildRows('section', false);
      }
    });
}

/* ------------------------------ Подборки -------------------------------- */

/* список подборок кэшируется на клиенте: возврат из подборки мгновенный */
var collectionsToken = 0;
var collectionsGrid = null;
var collectionsState = {
  items: [],        // загруженные подборки
  page: 0,
  hasMore: true,
  loading: false,
  current: null,    // открытая подборка ({id,title}) или null — список
};

function openCollections() {
  collectionsState.current = null;
  switchScreen('collections');
  renderCollectionsScreen();
  markNavCurrent();
}

function renderCollectionsScreen() {
  var token = ++collectionsToken;
  var c = $('#collections-content');
  var cur = collectionsState.current;
  c.innerHTML = '';
  c.appendChild(el('div', 'page-head',
    '<h1>' + esc(cur ? cur.title : 'Подборки') + '</h1>' +
    (cur ? '<div class="sub">Подборка</div>' : '')));
  var grid = el('div', 'grid');
  c.appendChild(grid);
  collectionsGrid = grid;

  if (!cur) {
    /* список: рисуем из кэша и догружаем страницы по мере листания */
    collectionsState.items.forEach(function (col) {
      grid.appendChild(collectionCard(col));
    });
    rebuildRows('collections', false);
    if (!collectionsState.items.length) {
      if (!collectionsState.loading) loadCollectionsPage(token);
    } else if (collectionsState.hasMore && !collectionsState.loading) {
      /* мягкая догрузка следующей страницы, пока пользователь смотрит список */
      loadCollectionsPage(token);
    }
    return;
  }

  api('/collections/' + cur.id).then(function (data) {
    if (token !== collectionsToken || collectionsState.current !== cur) return;
    var items = (data.items || []).map(adaptCard);
    items.forEach(remember);
    if (items.length) {
      items.forEach(function (t) { grid.appendChild(posterCard(t)); });
    } else {
      grid.appendChild(el('div', 'card-sub', 'Подборка пуста'));
    }
    rebuildRows('collections', false);
  }).catch(function (e) {
    if (token !== collectionsToken || collectionsState.current !== cur) return;
    if (e && e.code === 'not_registered') { showRegister(); return; }
    grid.appendChild(el('div', 'card-sub', 'Ошибка загрузки: ' + esc(e.message)));
    rebuildRows('collections', false);
  });
}

function loadCollectionsPage(token) {
  if (token == null) token = collectionsToken;
  if (collectionsState.loading || !collectionsState.hasMore) return;
  collectionsState.loading = true;
  var page = collectionsState.page + 1;
  api('/collections?page=' + page).then(function (res) {
    if (token !== collectionsToken) return;
    collectionsState.loading = false;
    var cols = res.items || [];
    collectionsState.items = collectionsState.items.concat(cols);
    collectionsState.page = page;
    collectionsState.hasMore = !!res.has_more;
    var grid = collectionsGrid;
    if (grid && collectionsState.current === null) {
      cols.forEach(function (col) { grid.appendChild(collectionCard(col)); });
      if (!collectionsState.items.length) {
        grid.appendChild(el('div', 'card-sub', 'Подборок пока нет'));
      }
      rebuildRows('collections', true);
    }
  }).catch(function (e) {
    if (token !== collectionsToken) return;
    collectionsState.loading = false;
    if (e && e.code === 'not_registered') { showRegister(); return; }
    toast('Не удалось загрузить подборки: ' + e.message);
  });
}

/* вход в подборку: заменяем сетку списка на сетку её тайтлов */
function openCollection(col) {
  collectionsState.current = col;
  renderCollectionsScreen();
}

/* -------------------------------- Поиск ---------------------------------- */

var BACKSPACE_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z"/></svg>';

var SEARCH_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" style="margin-right:10px"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';

var KB_LAYOUTS = {
  ru: [
    ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
    ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
    ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', '⌫'],
  ],
  en: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
  ],
  digits: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '.', ',', ':', '(', ')', '!', '?', '⌫'],
  ],
};

function renderSearch() {
  var c = $('#search-content');
  c.innerHTML = '';

  var query = el('div', 'query-bar',
    '<span class="q-label">Поиск</span><span class="q-text" id="q-text"></span><span class="q-caret"></span>');
  c.appendChild(query);

  var kb = el('div', 'kb');
  var layout = KB_LAYOUTS[state.kbLang];
  layout.forEach(function (rowKeys) {
    var row = el('div', 'kb-row');
    rowKeys.forEach(function (k) {
      var key = el('button', 'kb-key focusable' + (k === '⌫' ? ' wide' : ''));
      if (k === '⌫') key.innerHTML = BACKSPACE_ICON;
      else key.textContent = k;
      key.dataset.key = k;
      row.appendChild(key);
    });
    kb.appendChild(row);
  });
  var lastRow = el('div', 'kb-row');
  [['lang', null], ['layout', '123'], ['space', 'Пробел'], ['clear', 'Стереть всё'], ['go', 'Найти']]
    .forEach(function (pair) {
      var cls = 'kb-key wide focusable';
      var label = pair[1];
      if (pair[0] === 'lang') label = state.kbLang === 'ru' ? 'RU' : state.kbLang === 'en' ? 'EN' : '123';
      if (pair[0] === 'layout') label = state.kbLang === 'digits' ? 'АБВ' : '123';
      var key = el('button', cls);
      if (pair[0] === 'go') key.innerHTML = SEARCH_ICON + esc(label);
      else key.textContent = label;
      key.dataset.kb = pair[0];
      lastRow.appendChild(key);
    });
  kb.appendChild(lastRow);
  c.appendChild(kb);

  if (state.searchResults) renderSearchResults(c);

  buildBrowseRows('search');
  updateQueryBar();
}

function updateQueryBar() {
  var qt = document.getElementById('q-text');
  if (qt) qt.textContent = state.query || '';
}

function searchKey(key) {
  if (key.dataset.kb === 'go') { runSearch(); return; }
  if (key.dataset.kb === 'space') { state.query += ' '; updateQueryBar(); return; }
  if (key.dataset.kb === 'clear') { state.query = ''; updateQueryBar(); return; }
  if (key.dataset.kb === 'lang') {
    state.kbLang = state.kbLang === 'ru' ? 'en' : 'ru';
    var r = FOCUS.search.r, cc = FOCUS.search.c;
    renderSearch();
    FOCUS.search = { r: r, c: cc };
    applyFocus();
    return;
  }
  if (key.dataset.kb === 'layout') {
    state.kbLang = state.kbLang === 'digits' ? 'ru' : 'digits';
    var r2 = FOCUS.search.r, c2 = FOCUS.search.c;
    renderSearch();
    FOCUS.search = { r: r2, c: c2 };
    applyFocus();
    return;
  }
  var k = key.dataset.key;
  if (k === '⌫') state.query = state.query.slice(0, -1);
  else state.query += k;
  updateQueryBar();
}

function runSearch() {
  if (!state.query.trim()) { toast('Введите название'); return; }
  toast('Ищем: ' + state.query);
  api('/search?q=' + encodeURIComponent(state.query.trim()))
    .then(function (res) {
      state.searchResults = (res.items || []).map(adaptCard);
      state.searchResults.forEach(remember);
      renderSearch();
      FOCUS.search = { r: 1, c: 0 };
      applyFocus();
    })
    .catch(function (e) { toast('Ошибка поиска: ' + e.message); });
}

function renderSearchResults(c) {
  var items = state.searchResults;
  if (!items.length) {
    c.appendChild(el('div', 'empty-state',
      '<div class="es-icon">🔍</div>' +
      '<div class="es-title">Ничего не нашлось</div>' +
      '<div class="es-sub">Проверьте раскладку клавиатуры или измените запрос</div>'));
    return;
  }
  c.appendChild(el('div', 'page-head',
    '<h1>Результаты</h1><div class="sub">Найдено: ' + items.length + '</div>'));
  var g = el('div', 'grid');
  items.forEach(function (t) { g.appendChild(posterCard(t)); });
  c.appendChild(g);
}

function openSearch() {
  switchScreen('search');
  if (!SECTION_RENDERED.search) {
    renderSearch();
    FOCUS.search = { r: 1, c: 0 };
    SECTION_RENDERED.search = true;
  }
  markNavCurrent();
  applyFocus();
}

/* ------------------------------- Закладки -------------------------------- */

function renderBookmarks() {
  var c = $('#bookmarks-content');
  c.innerHTML = '';
  c.appendChild(el('div', 'page-head', '<h1>Закладки</h1><div class="sub" id="bm-sub">Загрузка…</div>'));

  if (!state.bookmarkFolders.length) {
    c.appendChild(el('div', 'empty-state',
      '<div class="es-icon">🔖</div>' +
      '<div class="es-title">Закладок пока нет</div>' +
      '<div class="es-sub">Откройте карточку фильма или сериала и нажмите «В закладки»</div>'));
    buildBrowseRows('bookmarks');
    markNavCurrent();
    applyFocus();
    return;
  }

  var tabs = el('div', 'tabs');
  state.bookmarkFolders.forEach(function (f) {
    var tab = el('div', 'tab focusable' + (f.id === state.bookmarkFolder ? ' active' : ''));
    tab.innerHTML = esc(f.title) + '<span class="tab-count">' + (f.count != null ? f.count : 0) + '</span>';
    tab.dataset.folder = f.id;
    tabs.appendChild(tab);
  });
  c.appendChild(tabs);
  c.appendChild(el('div', 'grid', '<div class="card-sub" style="grid-column:1/-1">Загрузка…</div>'));

  api('/bookmarks/' + state.bookmarkFolder)
    .then(function (res) {
      var grid = c.querySelector('.grid');
      if (!grid) return;
      grid.innerHTML = '';
      var items = (res.items || []).map(adaptCard);
      if (!items.length) {
        grid.appendChild(el('div', 'card-sub', 'В этой папке пусто'));
      } else {
        items.forEach(remember);
        items.forEach(function (t) { grid.appendChild(posterCard(t)); });
      }
      c.querySelector('#bm-sub').textContent = '';
      buildBrowseRows('bookmarks');
      if (!FOCUS.bookmarks || FOCUS.bookmarks.r >= ROWS.bookmarks.length) FOCUS.bookmarks = { r: 1, c: 0 };
      markNavCurrent();
      applyFocus();
    })
    .catch(function (e) { toast('Ошибка: ' + e.message); });
}

function openBookmarks() {
  switchScreen('bookmarks');
  if (SECTION_RENDERED.bookmarks && state.bookmarkFolders.length) {
    markNavCurrent(); applyFocus(); return;
  }
  api('/bookmarks')
    .then(function (res) {
      state.bookmarkFolders = res.folders || [];
      state.bookmarkFolder = state.bookmarkFolders.length ? state.bookmarkFolders[0].id : null;
      SECTION_RENDERED.bookmarks = true;
      renderBookmarks();
      FOCUS.bookmarks = { r: 1, c: 0 };
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Ошибка: ' + e.message);
    });
}

function bookmarkTab(tab) {
  state.bookmarkFolder = +tab.dataset.folder;
  Array.prototype.forEach.call(
    document.querySelectorAll('#bookmarks-content .tab'),
    function (t) { t.classList.toggle('active', t === tab); }
  );
  renderBookmarks();
}

/* -------------------------------- История -------------------------------- */

var historyToken = 0;

/* Одна карточка на тайтл: для сериала — последняя смотренная серия,
   для фильма — отметка «Просмотрен»; незавершённый прогресс — полосой
   на постере */
function historyCard(t) {
  var c = posterCard(t);
  var sub = c.querySelector('.card-sub');
  if (t.media && t.media.season != null) {
    sub.textContent = 'Сезон ' + t.media.season + ' · Серия ' + t.media.number;
  } else if (t.watched) {
    sub.textContent = 'Просмотрен';
  }
  if (t.progressPct > 0 && t.progressPct < 100) {
    c.querySelector('.poster-art').appendChild(
      el('div', 'poster-progress', '<i style="width:' + t.progressPct + '%"></i>')
    );
  }
  return c;
}

function renderHistory() {
  var token = ++historyToken;
  var c = $('#history-content');
  c.innerHTML = '';
  ROWS.history = [topRow()];
  c.appendChild(el('div', 'page-head', '<h1>История</h1><div class="sub">Начатое и просмотренное</div>'));

  var seen = {}, count = 0, built = false;
  var grid = null;

  function ensureGrid() {
    if (!grid) { grid = el('div', 'grid'); c.appendChild(grid); }
    return grid;
  }

  /* страницы истории грузятся последовательно и небыстро — дорисовываем
     по мере поступления, чтобы экран был живым сразу; сбой страницы не
     блокирует навигацию по уже загруженному */
  function loadPage(page) {
    api('/history?page=' + page)
      .then(function (res) {
        if (token !== historyToken) return;
        (res.items || []).forEach(function (raw) {
          var t = adaptCard(raw);
          if (!t.id || seen[t.id]) return;
          seen[t.id] = 1;
          remember(t);
          ensureGrid().appendChild(historyCard(t));
          count++;
        });
        if (count) {
          rebuildRows('history', built);
          built = true;
        }
        if (!count && !res.has_more) {
          c.appendChild(el('div', 'empty-state',
            '<div class="es-icon">🕘</div>' +
            '<div class="es-title">История пуста</div>' +
            '<div class="es-sub">Начните смотреть — здесь появится начатое и просмотренное</div>'));
          rebuildRows('history', false);
        }
        if (res.has_more) loadPage(page + 1);
      })
      .catch(function (e) {
        if (token !== historyToken) return;
        if (e && e.code === 'not_registered') { showRegister(); return; }
        if (count) {
          toast('Не удалось догрузить историю целиком');
        } else {
          c.appendChild(el('div', 'empty-state',
            '<div class="es-title">Ошибка загрузки</div>' +
            '<div class="es-sub">' + esc(e.message) + '</div>'));
          rebuildRows('history', false);
        }
      });
  }

  loadPage(1);
}

function openHistory() {
  switchScreen('history');
  /* история меняется после каждого просмотра — всегда перечитываем */
  renderHistory();
}

/* ------------------------------ Активация -------------------------------- *//* ------------------------------ Настройки -------------------------------- */

function setToggleRow(
  key,
  title,
  sub,
  on
) {
  var row = el('div', 'set-row focusable' + (on ? ' on' : ''));
  row.dataset.set = key;
  row.innerHTML = '<div>' + esc(title) + '<div class="row-sub">' + esc(sub) + '</div></div>' +
    '<div class="set-switch"><i></i></div>';
  return row;
}

function renderSettings() {
  var c = $('#settings-content');
  var s = (state.settings && state.settings.settings) || {};
  var account = state.settings && state.settings.account;
  c.innerHTML = '';
  c.appendChild(el('div', 'page-head', '<h1>Настройки</h1>'));

  /* карточка профиля: аккаунт и статус подписки (нефокусируемая) */
  if (account) {
    var name = account.username || account.name || '';
    var badge = '';
    var sub = account.subscription;
    if (sub) {
      if (sub.active) {
        var till = fmtTs(sub.end_time);
        var days = Math.floor(Number(sub.days));
        badge = '<span class="set-sub ok">Подписка активна' +
          (till ? ' · до ' + esc(till) : '') +
          (isFinite(days) ? ' · ' + days + ' дн.' : '') + '</span>';
      } else {
        badge = '<span class="set-sub bad">Подписка неактивна</span>';
      }
    }
    c.appendChild(el('div', 'set-profile',
      '<div class="set-avatar">' + esc((name || '?').charAt(0).toUpperCase()) + '</div>' +
      '<div class="set-id">' +
      '<div class="set-who">' + esc(name || 'Аккаунт KinoPub') + '</div>' +
      (account.email ? '<div class="set-mail">' + esc(account.email) + '</div>' : '') +
      (badge ? '<div class="set-subline">' + badge + '</div>' : '') +
      '</div>'));
  }

  var rows = el('div', 'set-rows');
  rows.appendChild(setToggleRow('uhd', '4K (Ultra HD)', 'Запрашивать 4K-стримы, если доступны', !!s.uhd));
  rows.appendChild(setToggleRow('hdr', 'HDR', 'HDR-версии видео', !!s.hdr));
  rows.appendChild(setToggleRow('hevc', 'HEVC (H.265)', 'Экономит трафик при той же качестве', !!s.hevc));
  rows.appendChild(setToggleRow('poster_size', 'Крупные постеры', 'Увеличенные постеры в списках и лентах', s.poster_size !== 'small'));
  c.appendChild(rows);

  buildBrowseRows('settings');
  FOCUS.settings = { r: 1, c: 0 };
  markNavCurrent();
  applyFocus();
}

function openSettings() {
  switchScreen('settings');
  if (SECTION_RENDERED.settings && state.settings) { markNavCurrent(); applyFocus(); return; }
  api('/settings')
    .then(function (res) {
      state.settings = res;
      SECTION_RENDERED.settings = true;
      renderSettings();
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Ошибка: ' + e.message);
    });
}

function toggleSetting(row) {
  var key = row.dataset.set;
  var s = (state.settings && state.settings.settings) || {};
  var patch = {};
  if (key === 'poster_size') patch.poster_size = s.poster_size === 'small' ? 'big' : 'small';
  else patch[key] = !s[key];
  var focusRow = FOCUS.settings.r;
  api('/settings', { method: 'POST', body: patch })
    .then(function (res) {
      /* POST отдаёт только настройки — профиль сохраняем из прошлого
         ответа, иначе блок подписки пропадает после каждого переключения */
      state.settings = {
        settings: res.settings,
        account: state.settings && state.settings.account,
      };
      renderSettings();
      FOCUS.settings = { r: Math.min(focusRow, ROWS.settings.length - 1), c: 0 };
      applyFocus();
      toast('Сохранено');
    })
    .catch(function (e) { toast('Ошибка: ' + e.message); });
}

/* ------------------------------ Активация -------------------------------- */

function navAction(id) {
  if (id === state.section && BROWSE_SCREENS.indexOf(state.screen) >= 0 &&
      state.screen !== 'catalog') {
    /* уже в этом разделе — просто снимаем фокус с меню */
    FOCUS[state.screen].r = Math.max(1, state.lastNavRow[state.screen] || 1);
    applyFocus();
    return;
  }
  openSection(id);
}

/* ------------------- Модал выбора папки закладок ------------------- */

function openBookmarkFolders() {
  var t = state.title;
  if (!t.folders.length) { toast('Нет папок закладок — создайте папку на kino.pub'); return; }
  state.modal = 'bookmarks';
  state.modalIdx = 0;
  renderModal();
}

function renderModal() {
  var t = state.title;
  var items = t.folders.map(function (f, i) {
    var inside = t.bookmarks.indexOf(f.id) >= 0;
    return '<div class="modal-item' + (i === state.modalIdx ? ' cur' : '') + '" data-i="' + i + '">' +
      '<span class="mi-check">' + (inside ? '✓' : '') + '</span>' +
      '<span class="mi-name">' + esc(f.title) + '</span>' +
      '<span class="mi-count">' + (f.count != null ? f.count : '') + '</span></div>';
  }).join('');
  $('#modal-box').innerHTML =
    '<div class="popup-title">Закладки</div>' + items;
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  state.modal = null;
  $('#modal').classList.add('hidden');
}

function syncBookmarkButton() {
  var t = state.title;
  var btn = document.querySelector('#screen-detail [data-act="bookmark"]');
  if (!btn) return;
  var on = t.bookmarks.length > 0;
  btn.classList.toggle('on', on);
  btn.querySelector('.b-txt').textContent = on ? '✓ В закладках' : 'В закладки';
}

function toggleBookmarkFolder(i) {
  var t = state.title;
  var f = t.folders[i];
  if (!f) return;
  var wasIn = t.bookmarks.indexOf(f.id) >= 0;
  api('/bookmarks/toggle', { method: 'POST', body: { item: t.id, folder: f.id } })
    .then(function (r) {
      t.bookmarks = r.bookmarks || [];
      var nowIn = t.bookmarks.indexOf(f.id) >= 0;
      if (f.count != null) f.count += (nowIn ? 1 : 0) - (wasIn ? 1 : 0);
      renderModal();
      syncBookmarkButton();
    })
    .catch(function (e) { toast('Ошибка: ' + e.message); });
}

function toggleLater(btn) {
  var t = state.title;
  api('/subscription/toggle', { method: 'POST', body: { id: t.id } })
    .then(function () {
      t.subscribed = !t.subscribed;
      btn.classList.toggle('on', t.subscribed);
      btn.querySelector('.b-txt').textContent = t.subscribed ? '✓ Буду смотреть' : 'Буду смотреть';
      toast(t.subscribed ? 'Добавлено в «Смотрю»' : 'Убрано из «Смотрю»');
    })
    .catch(function (e) { toast('Ошибка: ' + e.message); });
}

function activate() {
  var rows = ROWS[state.screen], f = FOCUS[state.screen];
  var elm = rows[f.r] && rows[f.r][f.c];
  if (!elm) return;

  if (BROWSE_SCREENS.indexOf(state.screen) >= 0) {
    if (elm.dataset.nav) return navAction(elm.dataset.nav);
  }

  if (state.screen === 'home') {
    if (elm.dataset.act === 'watch') return openPlayer(Number(elm.closest('.hero').dataset.id || FEATURED_ID));
    if (elm.dataset.act === 'more') return openDetail(FEATURED_ID);
    if (elm.dataset.kind === 'watch') return openPlayer(Number(elm.dataset.id));
    if (elm.dataset.kind === 'title') return openDetail(Number(elm.dataset.id));
  }

  if (state.screen === 'catalog' || state.screen === 'section' ||
      state.screen === 'collections' || state.screen === 'search' ||
      state.screen === 'bookmarks' || state.screen === 'history') {
    if (elm.dataset.key || elm.dataset.kb) return searchKey(elm);
    if (elm.dataset.folder) return bookmarkTab(elm);
    if (elm.dataset.kind === 'all') return openSectionGrid(elm.dataset.title, elm.dataset.url);
    if (elm.dataset.kind === 'collection') return openCollection({ id: +elm.dataset.id, title: elm.dataset.name });
    if (elm.dataset.kind === 'watch') return openPlayer(Number(elm.dataset.id));
    if (elm.dataset.kind === 'title') return openDetail(Number(elm.dataset.id));
  }

  if (state.screen === 'settings') {
    if (elm.dataset.set) return toggleSetting(elm);
  }

  if (state.screen === 'detail') {
    var a = elm.dataset.act;
    if (a === 'watch') return openPlayer(state.title.id);
    if (a === 'later') return toggleLater(elm);
    if (a === 'bookmark') return openBookmarkFolders();
    if (elm.dataset.season !== undefined) return seasonSelect(+elm.dataset.season);
    if (elm.dataset.e !== undefined) return openPlayer(state.title.id, +elm.dataset.s, +elm.dataset.e);
    if (elm.dataset.v !== undefined) return openPlayer(state.title.id, null, +elm.dataset.v);
    if (elm.dataset.kind === 'title') return openDetail(Number(elm.dataset.id));
  }
}

var FEATURED_ID = null;

/* ------------------------------ Клавиатура ------------------------------- */

/* Пульты ТВ отдают keycodes, браузеры — key; приводим к единому виду */
function normKey(e) {
  var map = {
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    13: 'Enter', 19: 'Pause', 415: 'Play', 412: 'Rewind', 417: 'FastForward',
    10009: 'Backspace', 461: 'Backspace', 27: 'Backspace', 8: 'Backspace',
    32: ' ',
  };
  if (e.key && e.key !== 'Unidentified' && map[e.keyCode] == null) return e.key;
  return map[e.keyCode] || e.key;
}

function playerKey(k, e) {
  if (state.popup) {
    var n = popupConfig(state.popup).items.length;
    if (k === 'ArrowUp') { state.popupIdx = Math.max(0, state.popupIdx - 1); renderPopup(); }
    else if (k === 'ArrowDown') { state.popupIdx = Math.min(n - 1, state.popupIdx + 1); renderPopup(); }
    else if (k === 'Enter') selectPopup(state.popupIdx);
    else if (k === 'Backspace') closePopup();
    else return;
    e.preventDefault();
    return;
  }
  if (k === 'Backspace') { goBack(); e.preventDefault(); return; }
  var vis = $('#player-overlay').classList.contains('visible');
  if (!vis) { showOverlay(); e.preventDefault(); return; }
  if (k === 'ArrowLeft') { FOCUS.player.c = Math.max(0, FOCUS.player.c - 1); applyFocus(); }
  else if (k === 'ArrowRight') { FOCUS.player.c = Math.min(ROWS.player[0].length - 1, FOCUS.player.c + 1); applyFocus(); }
  else if (k === 'Enter') activateControl(ROWS.player[0][FOCUS.player.c].dataset.c);
  else if (k === ' ' || k === 'Pause' || k === 'Play') { activateControl('play'); }
  else if (k === 'Rewind') { activateControl('rew'); }
  else if (k === 'FastForward') { activateControl('fwd'); }
  else return;
  showOverlay();
  e.preventDefault();
}

document.addEventListener('keydown', function (e) {
  var k = normKey(e);
  if (state.modal === 'bookmarks') {
    var n = state.title.folders.length;
    if (k === 'ArrowUp') { state.modalIdx = Math.max(0, state.modalIdx - 1); renderModal(); }
    else if (k === 'ArrowDown') { state.modalIdx = Math.min(n - 1, state.modalIdx + 1); renderModal(); }
    else if (k === 'Enter') toggleBookmarkFolder(state.modalIdx);
    else if (k === 'Backspace') closeModal();
    else return;
    e.preventDefault();
    return;
  }
  if (state.screen === 'player') return playerKey(k, e);
  if (k === 'ArrowLeft') move(-1, 0);
  else if (k === 'ArrowRight') move(1, 0);
  else if (k === 'ArrowUp') move(0, -1);
  else if (k === 'ArrowDown') move(0, 1);
  else if (k === 'Enter') activate();
  else if (k === 'Backspace') goBack();
  else return;
  e.preventDefault();
});

/* Видео-события — прогресс, конец, пауза */

(function wireVideo() {
  var video = playerVideo();
  video.addEventListener('timeupdate', function () {
    if (state.screen !== 'player') return;
    updateProgress();
  });
  video.addEventListener('pause', function () {
    state.playing = false;
    updateControlLabels();
    reportProgress();
  });
  video.addEventListener('play', function () {
    state.playing = true;
    updateControlLabels();
  });
  video.addEventListener('ended', function () {
    state.playing = false;
    updateControlLabels();
    reportProgress();
    toast('Просмотр завершён');
  });
  video.addEventListener('error', function () {
    if (state.screen === 'player') toast('Ошибка воспроизведения');
  });
})();

/* -------------------------------- Мышь ----------------------------------- */

function locate(rows, node) {
  for (var r = 0; r < rows.length; r++) {
    var c = rows[r].indexOf(node);
    if (c >= 0) return { r: r, c: c };
  }
  return null;
}

$('#stage').addEventListener('mouseover', function (e) {
  if (state.modal) {
    var mi = e.target.closest('.modal-item');
    if (mi) { state.modalIdx = +mi.dataset.i; renderModal(); }
    return;
  }
  if (state.popup) {
    var it = e.target.closest('.popup-item');
    if (it) { state.popupIdx = +it.dataset.i; renderPopup(); }
    return;
  }
  var f = e.target.closest('.focusable');
  if (!f || (state.screen === 'player' && !$('#player-overlay').classList.contains('visible'))) return;
  var rows = ROWS[state.screen];
  if (!rows) return;
  var pos = locate(rows, f);
  if (pos) { FOCUS[state.screen].r = pos.r; FOCUS[state.screen].c = pos.c; applyFocus(); }
});

$('#stage').addEventListener('mouseout', function (e) {
  if (state.popup || state.modal) return;
  if (state.screen === 'player' && !$('#player-overlay').classList.contains('visible')) return;
  var f = e.target.closest('.focusable');
  if (!f || !f.classList.contains('focused')) return;
  if (e.relatedTarget && f.contains(e.relatedTarget)) return;
  /* увод мыши гасит подсветку; запомненная FOCUS позиция сохраняется
     для пульта — applyFocus() вернёт её при следующем нажатии */
  clearFocused();
});

function clearFocused() {
  var els = document.querySelectorAll('.focused');
  for (var i = 0; i < els.length; i++) els[i].classList.remove('focused');
}

/* курсор покинул окно приложения целиком */
$('#stage').addEventListener('mouseleave', clearFocused);

$('#stage').addEventListener('click', function (e) {
  if (state.modal) {
    var mi = e.target.closest('.modal-item');
    if (mi) toggleBookmarkFolder(+mi.dataset.i);
    else if (e.target.id === 'modal') closeModal();
    return;
  }
  if (state.screen === 'player') {
    if (state.popup) {
      var it = e.target.closest('.popup-item');
      if (it) selectPopup(+it.dataset.i);
      else closePopup();
      return;
    }
    var vis = $('#player-overlay').classList.contains('visible');
    var b = e.target.closest('.pbtn');
    if (b && vis) {
      FOCUS.player.c = ROWS.player[0].indexOf(b);
      applyFocus();
      activateControl(b.dataset.c);
    }
    showOverlay();
    return;
  }
  var f = e.target.closest('.focusable');
  if (!f) return;
  var rows = ROWS[state.screen];
  if (!rows) return;
  var pos = locate(rows, f);
  if (pos) { FOCUS[state.screen].r = pos.r; FOCUS[state.screen].c = pos.c; applyFocus(); activate(); }
});

$('#screen-player').addEventListener('mousemove', function () {
  if (!state.popup) showOverlay();
});

/* ------------------------------ Масштаб ---------------------------------- */

function fit() {
  var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('#stage').style.transform = 'translate(-50%,-50%) scale(' + s + ')';
}
window.addEventListener('resize', fit);

/* --------------------------- Активация устройства ------------------------ */

var registerToken = 0;

function showRegister() {
  registerToken += 1;
  var token = registerToken;
  switchScreen('register');
  ROWS.register = [[]];
  $('#register-code').textContent = '·····';
  $('#register-qr').classList.add('hidden');
  $('#register-retry').classList.add('hidden');

  api('/auth/code', { method: 'POST' })
    .then(function (data) {
      if (token !== registerToken) return;
      $('#register-code').textContent = data.user_code;
      var qr = $('#register-qr');
      qr.src = '/api/v1/auth/qr.svg?code=' + encodeURIComponent(data.user_code);
      qr.classList.remove('hidden');
      setTimeout(pollRegister, 4000);

      function pollRegister() {
        if (token !== registerToken) return;
        api('/auth/poll')
          .then(function (r) {
            if (token !== registerToken) return;
            if (r.status === 'active') { boot(); return; }
            setTimeout(pollRegister, 5000);
          })
          .catch(function (e) {
            if (token !== registerToken) return;
            if (e.code === 'activation_expired') {
              $('#register-hint').textContent = e.message;
              showRegister();
              return;
            }
            setTimeout(pollRegister, 5000);
          });
      }
    })
    .catch(function (e) {
      if (token !== registerToken) return;
      if (e.code === 'already_registered') { boot(); return; }
      $('#register-hint').textContent = 'Не удалось получить код: ' + e.message;
      var retry = $('#register-retry');
      retry.classList.remove('hidden');
      retry.onclick = function () { showRegister(); };
      ROWS.register = [[retry]];
      applyFocus();
    });
}

/* --------------------------------- Init ---------------------------------- */

function boot() {
  renderNav();
  switchScreen('home');
  loadHome();
}

buildPlayer();
fit();
boot();
