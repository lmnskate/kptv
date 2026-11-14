'use strict';

/* Диагностика на ТВ (?debug=1): перехват ошибок + живой оверлей состояния.
   Должно стоять в самом верху — до любого кода, который может упасть */
var KPTV_DEBUG = /[?&]debug=1/.test(location.search);
var KPTV_ERRORS = [];
if (KPTV_DEBUG) {
  window.onerror = function (msg, src, line, col) {
    KPTV_ERRORS.push(String(msg) + ' @ ' + String(src || '').split('/').pop() + ':' + line + ':' + col);
    return false;
  };
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    KPTV_ERRORS.push('promise: ' + String((r && r.message) || r));
  });
}

/* слабые ТВ-движки: css .tv отключает все переходы/анимации */
if (/Tizen|webOS|Web0S|NetCast|SMART-TV|Smart-TV|VIDAA/i.test(navigator.userAgent)) {
  document.body.className += (document.body.className ? ' ' : '') + 'tv';
}

/* KPTV — клиент для Smart TV. Данные — через BFF /api/v1 (js/api.js). */

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
  ['cartoons', 'Мультфильмы'], ['collections', 'Подборки'], ['bookmarks', 'Закладки'],
  ['history', 'История'], ['settings', 'Настройки'],
];

/* Экраны с общим боковым меню («браузерные») */
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
  home: { r: 1, c: 0 }, detail: { r: 0, c: 0 }, player: { r: 1, c: 1 },
  register: { r: 0, c: 0 },
  catalog: { r: 1, c: 0 }, section: { r: 1, c: 0 }, collections: { r: 1, c: 0 },
  search: { r: 1, c: 0 }, bookmarks: { r: 1, c: 0 }, history: { r: 1, c: 0 },
  settings: { r: 1, c: 0 },
};

var state = {
  screen: 'home',
  prev: 'home',
  playerPrev: 'home',   // экран, из которого открыли плеер (возврат из плеера)
  section: 'home',      // активный пункт бокового меню
  lastNavRow: {},       // экран -> строка контента, с которой ушли в боковое меню
  lastNavCol: {},       // экран -> колонка контента, с которой ушли в меню
  title: null,          // объект тайтла (detail)
  detailStack: [],      // стек карточек detail → detail («Похожие»)
  season: 0,            // индекс сезона
  episode: 0,           // индекс серии
  playing: false,
  playInfo: null,       // последний ответ /play
  hls: null,
  qualityH: null,       // выбранная высота потока (null = Авто)
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
  sectionBack: null,    // {title, url} для возврата из сетки тайтлов жанра в сетку жанров
  sectionHome: false,   // сетка открыта из бокового меню → Back ведёт на главную
  cartoonGenre: null,   // id жанра «Мультфильм» (определяется один раз)
  bookmarkFolders: [],
  bookmarkFolder: null, // активная папка
  settings: null,
  catalogType: null,    // тип, чей контент сейчас в #catalog-content
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

/* wide=true — широкий бэкдроп (hero, «Продолжить просмотр», фон детальной
   страницы); иначе — узкий постер: бэкдропы весят 1–6 МБ, и когда каждая
   карточка в ленте грузит их, ТВ душится на декодировании */
function bgArt(t, angle, wide) {
  var url = wide ? (t.backdrop || t.poster) : (t.poster || t.backdrop);
  if (!url) return grad(t, angle);
  return 'url(&quot;' + esc(url) + '&quot;) center/cover, ' + grad(t, angle);
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
    inProgress: !!c.in_progress,
    subtitle: c.subtitle || '',
    media: c.media || null,
    watched: !!c.watched,
    watchedAt: Number(c.watched_at) || 0,   // last_seen, сортировка истории
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
    '<div class="cw-art" style="background:' + bgArt(t, 140, true) + '">' +
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

/* Карточка жанра — лента жанров в каталоге и сетка «Все жанры» */
function genreCard(genre, type) {
  var c = el('div', 'card focusable genre-card');
  c.dataset.kind = 'genre';
  c.dataset.id = genre.id;
  c.dataset.name = genre.title;
  c.dataset.type = type;
  c.innerHTML = '<div class="genre-art">' + esc(genre.title) + '</div>';
  return c;
}

/* Последняя карточка ленты — переход в полную сетку раздела.
   chip=true — компактный вариант для ленты жанров: чип того же размера,
   что и жанры (постерный вариант вытягивал всю ленту по высоте) */
function allCard(title, url, chip) {
  var c = el('div', 'card focusable card-all' + (chip ? ' genre-card' : ''));
  c.dataset.kind = 'all';
  c.dataset.title = title;
  c.dataset.url = url;
  c.innerHTML = chip
    ? '<div class="genre-art all-genre-art"><span class="all-chip-arrow">→</span> Смотреть все</div>'
    : '<div class="poster-art all-art"><span class="all-arrow">→</span></div>' +
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
  var list = el('div', 'nav-list');
  NAV.forEach(function (pair) {
    var id = pair[0], label = pair[1];
    var item = el('div', 'nav-item focusable' + (id === state.section ? ' current' : ''), esc(label));
    item.dataset.nav = id;
    list.appendChild(item);
  });
  nav.appendChild(list);
}

function markNavCurrent() {
  Array.prototype.forEach.call(
    document.querySelectorAll('#topnav .nav-item'),
    function (item) {
      item.classList.toggle('current', item.dataset.nav === state.section);
    }
  );
}

/* Строка 0 у браузерных экранов — общее боковое меню */
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
      '<div class="hero-bg" style="background:' + bgArt(f, 115, true) + '"></div>' +
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

/* Построение строк для экранов-разделов: боковое меню + все фокусные строки
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
    '<div class="detail-backdrop" style="background:' + bgArt(t, 120, true) + '"></div>' +
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

/* Дефолт — 1080p: точное совпадение по высоте, иначе максимум */
function pickDefaultLevel(levels) {
  var maxI = -1;
  for (var i = 0; i < levels.length; i++) {
    if (levels[i].height === 1080) return i;
    if (maxI < 0 || (levels[i].height || 0) > (levels[maxI].height || 0)) maxI = i;
  }
  return maxI;
}

/* Транспорт (перемотка/пауза/серии) — по центру; для сериалов добавляем
   переходы между сериями, для фильмов их нет. Субтитры/дорожка/качество —
   отдельной группой справа */
var TRANSPORT_MOVIE = [['rew', '10'], ['play', ''], ['fwd', '10']];
var TRANSPORT_SERIAL = [['prev', ''], ['rew', '10'], ['play', ''], ['fwd', '10'], ['next', '']];
var SIDE_CONTROLS = ['subs', 'audio', 'quality'];

function makePbtn(id, label) {
  var b = el('button', 'pbtn focusable pbtn-' + id);
  b.dataset.c = id;
  if (id === 'play') {
    b.innerHTML =
      '<span class="pi pi-play">' + PICON.play + '</span>' +
      '<span class="pi pi-pause hidden">' + PICON.pause + '</span>';
  } else if (label) {
    b.innerHTML = PICON[id] + '<span class="pbtn-label">' + esc(label) + '</span>';
  } else {
    /* кнопки без подписи (prev/next и правая группа): пустой span оставлял бы
       gap/margin после иконки — она висела бы не по центру кнопки */
    b.innerHTML = PICON[id];
  }
  return b;
}

function buildPlayer() {
  var bar = $('#player-controls');
  bar.innerHTML = '';
  var controls = (state.title && isSerial(state.title)) ? TRANSPORT_SERIAL : TRANSPORT_MOVIE;
  var transport = el('div', 'pbtn-transport');
  controls.forEach(function (pair) { transport.appendChild(makePbtn(pair[0], pair[1])); });
  bar.appendChild(transport);
  var side = el('div', 'pbtn-side');
  SIDE_CONTROLS.forEach(function (id) { side.appendChild(makePbtn(id)); });
  bar.appendChild(side);
  /* строка 0 — полоса прогресса (перемотка стрелками), строка 1 — кнопки */
  ROWS.player = [
    [document.getElementById('pp-track')],
    Array.prototype.slice.call(bar.querySelectorAll('.pbtn')),
  ];
  /* play — по центру группы */
  FOCUS.player = { r: 1, c: controls.length === TRANSPORT_SERIAL.length ? 2 : 1 };
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

/* шаг перемотки по полосе прогресса: ~1/60 длительности, от 15 с до 2 мин */
function seekStep() {
  var d = playerVideo().duration || (state.playInfo && state.playInfo.duration) || 0;
  return Math.max(15, Math.min(120, Math.floor(d / 60)));
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
  } else {
    /* фильмы/мультфильмы без второй строки: «год · тип» под названием
       читалось как мусор — для сериалов остаётся сезон/серия */
    $('#pv-ep').textContent = '';
  }
  $('#pp-total').textContent = fmtTime(info.duration);
  updateProgress();
}

function updateProgress() {
  var video = playerVideo();
  var duration = video.duration || (state.playInfo && state.playInfo.duration) || 0;
  var time = video.currentTime || 0;
  $('#pp-fill').style.width = (duration ? (time / duration) * 100 : 0) + '%';
  $('#pp-cur').textContent = fmtTime(time);
}

function updateControlLabels() {
  var video = playerVideo();
  var playBtn = document.querySelector('.pbtn-play');
  if (playBtn) {
    playBtn.querySelector('.pi-play').classList.toggle('hidden', state.playing);
    playBtn.querySelector('.pi-pause').classList.toggle('hidden', !state.playing);
  }
  var hasNext = state.title && isSerial(state.title) && nextEpisodeIndex() != null;
  var nextBtn = document.querySelector('.pbtn-next');
  if (nextBtn) nextBtn.classList.toggle('dim', !hasNext);
  var hasPrev = state.title && isSerial(state.title) && prevEpisodeIndex() != null;
  var prevBtn = document.querySelector('.pbtn-prev');
  if (prevBtn) prevBtn.classList.toggle('dim', !hasPrev);
  $('#player-paused').classList.toggle('hidden', state.playing || video.readyState === 0);
}

/* Попапы аудио/субтитров/качества строятся из реальных дорожек плеера */

/* Выбор аудио/субтитров запоминаем локально по id тайтла: у KinoPub нет
   предпочтений дорожек в настройках устройства, а пересоздание плеера
   (новый сеанс, другая серия) сбрасывало выбор */
var TRACK_PREFS_KEY = 'kptv-track-prefs';

function trackPrefs() {
  try { return JSON.parse(localStorage.getItem(TRACK_PREFS_KEY)) || {}; }
  catch (e) { return {}; }
}

function trackPref(kind) {
  var info = state.playInfo;
  if (!info || !info.content_id) return null;
  var p = trackPrefs()[String(info.content_id)];
  return p ? p[kind] : null;
}

function saveTrackPref(kind, value) {
  var info = state.playInfo;
  if (!info || !info.content_id) return;
  var all = trackPrefs();
  var id = String(info.content_id);
  all[id] = all[id] || {};
  all[id][kind] = value;
  try { localStorage.setItem(TRACK_PREFS_KEY, JSON.stringify(all)); }
  catch (e) { /* quota / приватный режим — выбор просто не сохранится */ }
}

/* Единый список субтитров: встроенные дорожки манифеста (hls.js отдаёт свой
   список, нативный плеер — только textTracks) + внешние WebVTT-файлы из
   /play. Лейблы внешних файлов намеренно дублируют стиль манифеста
   («RUS #01»), совпадения переименовываем с пометкой «(файл)» */
function subtitleOptions() {
  var opts = [{ kind: 'off', label: 'Выкл' }];
  var seen = { 'Выкл': true };
  var i, label;
  if (state.hls) {
    var list = state.hls.subtitleTracks || [];
    for (i = 0; i < list.length; i++) {
      label = list[i].name || ('Субтитры ' + (i + 1));
      if (!seen[label]) { opts.push({ kind: 'embedded', index: i, label: label }); seen[label] = true; }
    }
  } else {
    Array.prototype.forEach.call(playerVideo().textTracks, function (t) {
      if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
      label = t.label || t.language;
      if (label && !seen[label]) { opts.push({ kind: 'embedded', index: 0, label: label }); seen[label] = true; }
    });
  }
  (state.playInfo.subtitles || []).forEach(function (s, ix) {
    label = seen[s.label] ? s.label + ' (файл)' : s.label;
    if (!seen[label]) { opts.push({ kind: 'external', index: ix, label: label }); seen[label] = true; }
  });
  return opts;
}

/* TextTrack-объекты внешних <track>-элементов: по индексу в video.textTracks
   их искать нельзя — hls.js подмешивает туда свои встроенные дорожки */
function externalTextTracks() {
  var res = [];
  Array.prototype.forEach.call(playerVideo().querySelectorAll('track'), function (n) {
    if (n.track) res.push(n.track);
  });
  return res;
}

/* Применить выбор субтитров: встроенные дорожки ведём через API hls.js
   (прямое присвоение mode он переприменяет сам), внешние — через mode */
function applySubChoice(value) {
  state.subs = value;
  var choice = null;
  subtitleOptions().forEach(function (o) { if (o.label === value) choice = o; });
  var video = playerVideo();
  var ext = externalTextTracks();
  ext.forEach(function (t) { t.mode = 'hidden'; });
  if (state.hls) {
    if (choice && choice.kind === 'embedded') {
      state.hls.subtitleDisplay = true;
      state.hls.subtitleTrack = choice.index;
    } else {
      state.hls.subtitleDisplay = false;
      state.hls.subtitleTrack = -1;
    }
  } else {
    Array.prototype.forEach.call(video.textTracks, function (t) {
      if (ext.indexOf(t) >= 0) return;
      t.mode = (choice && choice.kind === 'embedded' && t.label === value) ? 'showing' : 'hidden';
    });
  }
  if (choice && choice.kind === 'external' && ext[choice.index]) {
    ext[choice.index].mode = 'showing';
  }
  saveTrackPref('subs', value);
}

/* Восстановление сохранённого выбора дорожек: списки аудио и встроенных
   субтитров доступны только после разбора манифеста */
function restoreTracks() {
  var audio = trackPref('audio');
  if (audio && state.hls && state.hls.audioTracks) {
    for (var i = 0; i < state.hls.audioTracks.length; i++) {
      if ((state.hls.audioTracks[i].name || '') === audio) { state.hls.audioTrack = i; break; }
    }
  }
  var subs = trackPref('subs');
  if (!subs) return;
  var known = false;
  subtitleOptions().forEach(function (o) { if (o.label === subs) known = true; });
  if (known) applySubChoice(subs);
  else state.subs = 'Выкл';
}

function restoreOnMeta(video) {
  var onMeta = function () {
    video.removeEventListener('loadedmetadata', onMeta);
    restoreTracks();
  };
  video.addEventListener('loadedmetadata', onMeta);
}

function popupConfig(kind) {
  if (kind === 'subs') {
    var items = subtitleOptions().map(function (o) { return o.label; });
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
    return { title: 'Качество', items: qlabels, current: state.qualityH ? state.qualityH + 'p' : 'Авто' };
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
    applySubChoice(value);
    toast('Субтитры: ' + value);
  } else if (kind === 'audio') {
    if (state.hls && state.hls.audioTracks && state.hls.audioTracks.length) {
      state.hls.audioTrack = i;
      saveTrackPref('audio', value);
      toast('Аудиодорожка: ' + value);
    } else {
      toast('Переключение недоступно на этом устройстве');
    }
  } else if (kind === 'quality') {
    if (state.hls && state.hls.levels && state.hls.levels.length) {
      if (value === 'Авто') {
        state.hls.currentLevel = -1;
        state.qualityH = null;
      } else {
        var height = parseInt(value, 10);
        for (var li = 0; li < state.hls.levels.length; li++) {
          if (state.hls.levels[li].height === height) { state.hls.currentLevel = li; break; }
        }
        state.qualityH = height;
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
  state.qualityH = null;

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

  /* hls.js — в приоритете везде, где есть MSE: только он даёт переключение
     качества и аудиодорожек (у нативного плеера их списки недоступны).
     Нативный HLS — фолбэк для устройств без MSE и при фатальной ошибке
     hls.js (например, неподдерживаемый кодек в манифесте) */
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls();
    state.hls = hls;
    /* иначе hls.js сам включает дорожку с DEFAULT=YES из манифеста, и
       субтитры появляются вопреки «Выкл» в меню */
    hls.subtitleDisplay = false;
    hls.on(Hls.Events.ERROR, function (e, d) {
      if (!d || !d.fatal) return;
      try { hls.destroy(); } catch (err) {}
      state.hls = null;
      video.src = info.url;
      restoreOnMeta(video);
      var p = video.play();
      if (p && p.catch) { p.catch(function () {}); }
      toast('Включён режим совместимости — выбор качества и дорожек недоступен');
    });
    hls.loadSource(info.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      var ix = pickDefaultLevel(hls.levels || []);
      if (ix >= 0) {
        hls.currentLevel = ix;
        state.qualityH = hls.levels[ix].height || null;
      }
      restoreTracks();
      updateControlLabels();
    });
  } else {
    video.src = info.url;
    restoreOnMeta(video);
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

  /* фокус в боковом меню: панель фиксированная и всегда видима — контент
     не скроллим, иначе прощелкивание пунктов дёргает страницу вверх-вниз */
  var inNav = elm.closest ? elm.closest('#topnav') : null;
  var content = screenEl.querySelector('.scroll-content');
  if (content && !inNav) {
    var vrow = elm.closest('.vrow');
    var host = vrow || elm;
    var top = offsetTopIn(host, content);
    var h = host.offsetHeight;
    /* скроллим минимально: только когда фокус уходит за край видимой зоны,
       иначе страница «дергается» на каждом нажатии. Сравниваем с высотой
       блока целиком — иначе высокие ряды обрезаются снизу. Низ контента
       меряем по последнему ребёнку, а не по scrollHeight: Firefox и часть
       ТВ-движков не включают padding-bottom в scrollHeight.
       Весь контент помещается на экране — скролл принудительно 0: запас
       BOTTOM_GAP снизу иначе создаёт фантомное переполнение, и страница
       дёргается разок на последнем ряду (было на экране настроек) */
    var last = content.lastElementChild;
    var yMax = 0;
    var fits = false;
    if (last) {
      var lastBottom = offsetTopIn(last, content) + last.offsetHeight;
      yMax = Math.max(0, lastBottom + BOTTOM_GAP - 1080);
      fits = lastBottom <= 1080;
    }
    var m = /translateY\((-?\d+)px\)/.exec(content.style.transform || '');
    var y = m ? -parseInt(m[1], 10) : 0;
    if (fits) y = 0;
    else if (top < y + 130) y = Math.max(0, top - 240);
    else if (top + h > y + 1080 - BOTTOM_GAP) y = Math.min(top + h - 1080 + BOTTOM_GAP, yMax);
    y = Math.max(0, Math.min(y, yMax));
    content.style.transform = 'translateY(' + (-y) + 'px)';
  }
  var track = elm.closest('.track');
  if (track) {
    /* то же самое по горизонтали: лента сдвигается только когда карточка
       выходит за правый/левый край. Видимая ширина зависит от экрана:
       браузерные смещены боковой панелью, деталь — нет */
    var avail = track.parentElement.clientWidth - 8;
    var max = Math.max(0, track.scrollWidth - avail);
    var tm = /translateX\((-?\d+)px\)/.exec(track.style.transform || '');
    var shift = tm ? -parseInt(tm[1], 10) : 0;
    var left = elm.offsetLeft, w = elm.offsetWidth;
    if (left < shift + 8) shift = Math.max(0, left - 24);
    else if (left + w > shift + avail - 8) shift = Math.min(left + w + 24 - avail, max);
    shift = Math.max(0, Math.min(shift, max));
    track.style.transform = 'translateX(' + (-shift) + 'px)';
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

/* вход в боковое меню: запоминаем позицию в контенте, встаём на пункт
   текущего раздела */
function enterMenu(rows, f) {
  state.lastNavRow[state.screen] = f.r;
  state.lastNavCol[state.screen] = f.c;
  f.r = 0;
  f.c = 0;
  for (var k = 0; k < rows[0].length; k++) {
    if (rows[0][k].dataset.nav === state.section) { f.c = k; break; }
  }
}

/* выход из меню обратно в контент — на запомненную позицию */
function leaveMenu(rows, f) {
  f.r = Math.min(state.lastNavRow[state.screen] || 1, rows.length - 1);
  f.c = Math.min(state.lastNavCol[state.screen] || 0, rows[f.r].length - 1);
}

function move(dx, dy) {
  var rows = ROWS[state.screen], f = FOCUS[state.screen];
  if (!rows.length) return;
  var browse = BROWSE_SCREENS.indexOf(state.screen) >= 0;
  if (browse && f.r === 0) {
    /* фокус в боковом меню: ↑/↓ листают пункты, → (или ↓ за последним
       пунктом) возвращает в контент */
    if (dy) {
      var nc = f.c + dy;
      if (nc >= 0 && nc < rows[0].length) f.c = nc;
      else if (dy > 0) leaveMenu(rows, f);
    } else if (dx > 0) {
      leaveMenu(rows, f);
    }
    applyFocus();
    return;
  }
  if (browse && dx < 0 && f.r > 0 && f.c === 0) {
    /* ← с первой колонки — в боковое меню */
    enterMenu(rows, f);
    applyFocus();
    return;
  }
  if (dy) {
    var r = f.r + dy;
    if (r >= rows.length) return;
    if (r < 0) return;
    if (r === 0 && browse) {
      enterMenu(rows, f);
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
    /* на главной Backspace из бокового меню уходит в контент */
    if (FOCUS.home.r === 0) { leaveMenu(ROWS.home, FOCUS.home); applyFocus(); }
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
    if (state.sectionBack) {
      /* из сетки тайтлов жанра — обратно в сетку жанров */
      openSectionGrid(state.sectionBack.title, state.sectionBack.url);
    } else if (state.sectionHome) {
      /* сетка открыта из меню (например, «Мультфильмы») — обратно на главную */
      openSection('home');
    } else {
      /* из сетки «Смотреть все» — обратно в каталог */
      switchScreen('catalog');
    }
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

/* раздел меню -> экран, который он открывает */
var SECTION_SCREENS = {
  home: 'home', movies: 'catalog', serials: 'catalog', cartoons: 'section',
  collections: 'collections', search: 'search', bookmarks: 'bookmarks',
  history: 'history', settings: 'settings',
};

/* Навигация через меню всегда открывает раздел сначала: фокус — на первую
   строку контента, прокрутка — наверх. Иначе экран открывался с тем фокусом
   и скроллом, с каким его покидали (вплоть до фокуса, застрявшего в самом
   меню): позиция береглась для возврата Back, а не для смены раздела */
function resetScreenTop(id) {
  var name = SECTION_SCREENS[id];
  if (!name) return;
  FOCUS[name] = { r: 1, c: 0 };
  var content = document.getElementById(SCREEN_CONTENT[name]);
  if (content) content.style.transform = 'translateY(0)';
}

function openSection(id) {
  state.section = id;
  resetScreenTop(id);
  if (id === 'home') return openHome();
  if (id === 'movies' || id === 'serials') return openCatalog(id === 'movies' ? 'movie' : 'serial');
  if (id === 'cartoons') return openCartoons();
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
  /* контейнер один на оба типа: ранний выход по кэшу допустим, только
     если в нём сейчас именно этот тип (иначе во «Фильмах» остаются
     сериалы после захода в «Сериалы» и наоборот) */
  if (SECTION_RENDERED['catalog:' + type] && state.catalogType === type) {
    markNavCurrent();
    return;
  }
  state.catalogType = type;
  var c = $('#catalog-content');
  c.innerHTML = '';
  ROWS.catalog = [topRow()];
  var loading = el('div', 'page-head', '<div class="sub">Загрузка…</div>');
  c.appendChild(loading);

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

  /* лента жанров — наверху страницы, до контентных секций */
  var genreSlot = el('div');
  c.appendChild(genreSlot);
  pending++;
  api('/genres?type=' + type).then(function (res) {
    if (token !== catalogToken) return;
    var raw = (res && res.items) || [];
    if (!raw.length) return;
    var cards = raw.slice(0, RAIL_LIMIT).map(function (g) {
      return genreCard(g, type);
    });
    if (raw.length > RAIL_LIMIT) {
      cards.push(allCard('Жанры', 'genres:' + type, true));
    }
    genreSlot.appendChild(rail('Жанры', cards, 'rail-first'));
    made++;
    if (made === 1) loading.remove();
    SECTION_RENDERED['catalog:' + type] = true;
    rebuildRows('catalog', true);
  }, function () {
    /* жанры не загрузились — просто не показываем ленту */
  }).then(settle);

  /* секции грузятся и рисуются независимо: сбой или зависание одной не
     блокирует остальные (раньше Promise.all ронял весь экран). Слоты —
     чтобы порядок лент не зависел от порядка ответов */
  [['Новинки', '/catalog?section=fresh&type=' + type],
   ['Популярное', '/catalog?section=popular&type=' + type],
   ['Лучшее', '/catalog?type=' + type + '&sort=views-'],
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

/* Мультфильмы — жанровая сетка (кино + сериалы). Id жанра определяем по
   справочнику (ищем «мультфильм»), 23 — исторически известный fallback */
function openCartoons() {
  var cached = state.cartoonGenre;
  var genrePromise = cached
    ? Promise.resolve(cached)
    : api('/genres?type=movie')
        .then(function (res) {
          var items = (res && res.items) || [];
          var found = null;
          items.forEach(function (g) {
            if (found == null && /мультфильм/i.test(g.title || '')) found = g.id;
          });
          state.cartoonGenre = found != null ? found : 23;
          return state.cartoonGenre;
        })
        .catch(function () { return 23; });
  genrePromise.then(function (genre) {
    openSectionGrid('Мультфильмы', '/catalog?genre=' + genre, true);
  });
}

/* --------------------- Сетка раздела («Смотреть все») --------------------- */

var sectionToken = 0;

function openSectionGrid(title, url, homeBack) {
  var token = ++sectionToken;
  FOCUS.section = { r: 1, c: 0 };
  state.sectionUrl = url;
  state.sectionPage = 0;
  state.sectionHasMore = true;
  state.sectionLoading = false;
  state.sectionBack = null;
  state.sectionHome = !!homeBack;
  switchScreen('section');

  var c = $('#section-content');
  c.innerHTML = '';
  c.style.transform = 'translateY(0)';
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

  /* сетка всех жанров: один запрос, без пагинации */
  if (state.sectionUrl.indexOf('genres:') === 0) {
    var type = state.sectionUrl.slice('genres:'.length);
    api('/genres?type=' + type)
      .then(function (res) {
        if (token !== sectionToken) return;
        state.sectionLoading = false;
        state.sectionHasMore = false;
        state.sectionPage = 1;
        var genres = (res && res.items) || [];
        genres.forEach(function (g) {
          state.sectionGrid.appendChild(genreCard(g, type));
        });
        if (!genres.length) {
          state.sectionGrid.appendChild(el('div', 'card-sub', 'Ничего не нашлось'));
        }
        rebuildRows('section', true);
      })
      .catch(function (e) {
        if (token !== sectionToken) return;
        state.sectionLoading = false;
        if (e && e.code === 'not_registered') { showRegister(); return; }
        state.sectionGrid.appendChild(el('div', 'card-sub', 'Ошибка загрузки: ' + esc(e.message)));
        rebuildRows('section', false);
      });
    return;
  }

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

  /* vrow — клавиатура скроллится как единый блок, а не по строкам */
  var kb = el('div', 'kb vrow');
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
var historyTab = 'all';
var historyItems = [];
var HISTORY_TABS = [['all', 'Все'], ['movie', 'Фильмы'], ['serial', 'Сериалы']];

/* Единая лента без деления на «продолжить»/«просмотренное»: бэкенд отдаёт
   одну карточку на тайтл (серии схлопнуты в «Сезон · Серию» самого свежего
   просмотра), уже отсортированную по свежести. Порядок на клиенте не
   трогаем — пересортировка давала «прыгающие» записи. */
function historyCard(t) {
  var c = posterCard(t);
  var sub = c.querySelector('.card-sub');
  if (t.type === 'serial' && t.media && t.media.season != null) {
    sub.textContent = 'Сезон ' + t.media.season + ' · Серия ' + t.media.number;
  }
  if (t.progressPct > 0 && t.progressPct < 100) {
    c.querySelector('.poster-art').appendChild(
      el('div', 'poster-progress', '<i style="width:' + t.progressPct + '%"></i>')
    );
  }
  return c;
}

function historyFiltered() {
  if (historyTab === 'all') return historyItems;
  return historyItems.filter(function (t) { return t.type === historyTab; });
}

/* Сетка создаётся один раз и дальше дорисовывается инкрементально —
   пересоздание body на каждой странице давало заметное мигание списка */
function historyGrid() {
  var body = $('#history-body');
  var grid = body.querySelector('.grid');
  if (!grid) {
    grid = el('div', 'grid');
    body.appendChild(grid);
  }
  return grid;
}

/* Дорисовка новых карточек без пересборки списка; порядок — как пришёл
   от бэкенда */
function appendHistoryCards(list) {
  var grid = historyGrid();
  list.forEach(function (t) {
    if (historyTab !== 'all' && t.type !== historyTab) return;
    grid.appendChild(historyCard(t));
  });
}

/* Полная перерисовка: смена вкладки или конец загрузки с пустым результатом */
function renderHistoryBody(done) {
  var body = $('#history-body');
  if (!body) return;
  body.innerHTML = '';

  var shown = historyFiltered();
  if (!shown.length) {
    if (!done) return;
    body.appendChild(el('div', 'empty-state',
      '<div class="es-icon">🕘</div>' +
      '<div class="es-title">' + (historyItems.length ? 'В этой вкладке пусто' : 'История пуста') + '</div>' +
      '<div class="es-sub">' + (historyItems.length
        ? 'Переключитесь на другую вкладку'
        : 'Начните смотреть — здесь появится начатое и просмотренное') + '</div>'));
    rebuildRows('history', false);
    return;
  }

  appendHistoryCards(shown);
}

function historyTabSelect(tab) {
  historyTab = tab.dataset.htab;
  Array.prototype.forEach.call(
    document.querySelectorAll('#history-content .tab'),
    function (t) { t.classList.toggle('active', t === tab); }
  );
  renderHistoryBody(true);
  /* фокус остаётся на выбранной вкладке (сами табы не пересоздаются) */
  rebuildRows('history', true);
}

function renderHistory() {
  var token = ++historyToken;
  var c = $('#history-content');
  c.innerHTML = '';
  ROWS.history = [topRow()];
  c.appendChild(el('div', 'page-head', '<h1>История</h1><div class="sub">Начатое и просмотренное</div>'));

  var tabs = el('div', 'tabs');
  HISTORY_TABS.forEach(function (pair) {
    var tab = el('div', 'tab focusable' + (pair[0] === historyTab ? ' active' : ''));
    tab.textContent = pair[1];
    tab.dataset.htab = pair[0];
    tabs.appendChild(tab);
  });
  c.appendChild(tabs);

  var body = el('div', null);
  body.id = 'history-body';
  c.appendChild(body);

  var seen = {}, built = false;
  historyItems = [];

  /* страницы истории грузятся последовательно и небыстро — дорисовываем
     по мере поступления, чтобы экран был живым сразу; сбой страницы не
     блокирует навигацию по уже загруженному */
  function loadPage(page) {
    api('/history?page=' + page)
      .then(function (res) {
        if (token !== historyToken) return;
        var fresh = [];
        (res.items || []).forEach(function (raw) {
          var t = adaptCard(raw);
          if (!t.id || seen[t.id]) return;
          seen[t.id] = 1;
          remember(t);
          historyItems.push(t);
          fresh.push(t);
        });
        appendHistoryCards(fresh);
        if (historyItems.length) {
          rebuildRows('history', built);
          built = true;
        }
        if (res.has_more) { loadPage(page + 1); }
        else if (!historyItems.length || !historyFiltered().length) {
          renderHistoryBody(true);
        }
      })
      .catch(function (e) {
        if (token !== historyToken) return;
        if (e && e.code === 'not_registered') { showRegister(); return; }
        if (historyItems.length) {
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

/* ------------------------------ Настройки -------------------------------- */

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
  rows.appendChild(setToggleRow('hevc', 'HEVC (H.265)', 'Экономит трафик при том же качестве', !!s.hevc));
  c.appendChild(rows);

  var acts = el('div', 'set-rows set-acts');
  var reboot = el('div', 'set-row focusable');
  reboot.dataset.act = 'reboot';
  reboot.innerHTML = '<div>' + esc('Перезагрузка приложения') +
    '<div class="row-sub">' + esc('Перезапуск и очистка кэша') + '</div></div>' +
    '<div class="set-act-ico">↻</div>';
  acts.appendChild(reboot);
  c.appendChild(acts);

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
  patch[key] = !s[key];
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

/* Перезагрузка приложения с очисткой кэша. Чистим Cache Storage, если
   движок его отдаёт; HTTP-кэш самого клиента и так не кэшируется
   (no-cache в ответах сервера). localStorage НЕ трогаем — там id устройства */
function reloadApp() {
  var go = function () { window.location.reload(); };
  try {
    if (window.caches && caches.keys) {
      caches.keys().then(function (names) {
        return Promise.all(names.map(function (n) { return caches.delete(n); }));
      }).then(go, go);
      return;
    }
  } catch (e) { /* старые движки без Cache Storage — просто перезагрузка */ }
  go();
}

function navAction(id) {
  if (id === state.section && BROWSE_SCREENS.indexOf(state.screen) >= 0 &&
      state.screen !== 'catalog') {
    /* уже в этом разделе — просто снимаем фокус с меню */
    leaveMenu(ROWS[state.screen], FOCUS[state.screen]);
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
    if (elm.dataset.htab) return historyTabSelect(elm);
    if (elm.dataset.kind === 'all') return openSectionGrid(elm.dataset.title, elm.dataset.url);
    if (elm.dataset.kind === 'genre') {
      openSectionGrid(elm.dataset.name,
        '/catalog?type=' + elm.dataset.type + '&genre=' + elm.dataset.id);
      state.sectionBack = { title: 'Жанры', url: 'genres:' + elm.dataset.type };
      return;
    }
    if (elm.dataset.kind === 'collection') return openCollection({ id: +elm.dataset.id, title: elm.dataset.name });
    if (elm.dataset.kind === 'watch') return openPlayer(Number(elm.dataset.id));
    if (elm.dataset.kind === 'title') return openDetail(Number(elm.dataset.id));
  }

  if (state.screen === 'settings') {
    if (elm.dataset.act === 'reboot') return reloadApp();
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
  var f = FOCUS.player;
  if (k === 'ArrowUp') {
    if (f.r > 0) { f.r = 0; applyFocus(); }
  } else if (k === 'ArrowDown') {
    if (f.r < ROWS.player.length - 1) { f.r = ROWS.player.length - 1; applyFocus(); }
  } else if (k === 'ArrowLeft') {
    /* на полосе прогресса стрелки мотают, на кнопках — двигают фокус */
    if (f.r === 0) seekBy(-seekStep());
    else { f.c = Math.max(0, f.c - 1); applyFocus(); }
  } else if (k === 'ArrowRight') {
    if (f.r === 0) seekBy(seekStep());
    else { f.c = Math.min(ROWS.player[1].length - 1, f.c + 1); applyFocus(); }
  }
  else if (k === 'Enter') { if (f.r === 1) activateControl(ROWS.player[1][f.c].dataset.c); }
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
    var tr = e.target.closest('#pp-track');
    if (tr && vis) {
      /* клик по полосе прогресса — переход в точку */
      var rect = tr.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var video = playerVideo();
      if (video.duration) { video.currentTime = ratio * video.duration; updateProgress(); }
      showOverlay();
      return;
    }
    var b = e.target.closest('.pbtn');
    if (b && vis) {
      FOCUS.player.r = 1;
      FOCUS.player.c = ROWS.player[1].indexOf(b);
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

/* ТВ-вебвью (Tizen/MSX) ненадёжен на translate(-50%,-50%) и врёт в
   innerWidth/innerHeight в первые секунды после навигации — поэтому
   центрируем пиксельными left/top, а в transform оставляем только scale().
   Пересчитываем несколько раз после загрузки: финальный вьюпорт ТВ
   отдаёт с задержкой */
function fit() {
  /* Tizen/MSX-вебвью врёт в window.innerWidth (2880x1620 при реальных
     1920x1080); documentElement.clientWidth отдаёт честный layout-вьюпорт.
     Берём минимум из двух — в обычных браузерах они совпадают */
  var de = document.documentElement;
  var w = Math.min(window.innerWidth || Infinity, de.clientWidth || Infinity);
  var h = Math.min(window.innerHeight || Infinity, de.clientHeight || Infinity);
  if (!isFinite(w) || !isFinite(h) || !w || !h) return;
  var s = Math.min(w / 1920, h / 1080);
  var stage = $('#stage');
  stage.style.transformOrigin = '0 0';
  stage.style.transform = 'scale(' + s + ')';
  stage.style.left = Math.max(0, Math.round((w - 1920 * s) / 2)) + 'px';
  stage.style.top = Math.max(0, Math.round((h - 1080 * s) / 2)) + 'px';
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);
window.addEventListener('load', function () {
  fit();
  setTimeout(fit, 300);
  setTimeout(fit, 1000);
  setTimeout(fit, 2500);
});

/* отладка на реальном ТВ: /client/?debug=1 — живой оверлей с состоянием
   приложения и перехваченными ошибками, обновляется раз в секунду */
function debugTick() {
  if (!KPTV_DEBUG) return;
  var d = document.getElementById('fit-debug');
  if (!d) {
    d = document.createElement('div');
    d.id = 'fit-debug';
    d.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;' +
      'background:rgba(0,0,0,.85);color:#0f0;font:18px monospace;padding:10px;' +
      'white-space:pre-wrap;max-width:96vw;';
    document.body.appendChild(d);
  }
  var de = document.documentElement;
  var stage = document.getElementById('stage');
  var home = document.getElementById('screen-home');
  var content = document.getElementById('home-content');
  var cs = home && window.getComputedStyle ? getComputedStyle(home) : null;
  var hero = document.querySelector('.hero');
  var hr = hero ? hero.getBoundingClientRect() : null;
  d.textContent =
    'inner ' + window.innerWidth + 'x' + window.innerHeight +
    ' docEl ' + de.clientWidth + 'x' + de.clientHeight +
    ' dpr ' + (window.devicePixelRatio || 1) + '\n' +
    'stage: ' + (stage ? stage.style.cssText.replace(/;\s*/g, ' ') : '?') + '\n' +
    'screen=' + state.screen +
    ' homeCls="' + (home ? home.className : '?') + '"' +
    ' op=' + (cs ? cs.opacity : '?') +
    ' kids=' + (content ? content.childElementCount : '?') +
    ' transform=' + (content ? (content.style.transform || 'none') : '?') + '\n' +
    'heroRect=' + (hr ? (Math.round(hr.x) + ',' + Math.round(hr.y) + ' ' + Math.round(hr.width) + 'x' + Math.round(hr.height)) : 'none') +
    ' rows=' + (ROWS.home || []).length + '\n' +
    'errors: ' + (KPTV_ERRORS.slice(-3).join(' | ') || 'none');
}
setInterval(debugTick, 1000);

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
