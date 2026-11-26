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

/* Иконки пустых состояний — инлайн-SVG: эмодзи на старых ТВ-вебвью
   (Tizen 2.4/4) рисуются «тофу»-квадратами */
var EMPTY_ICONS = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>',
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>'
};

function emptyState(icon, title, sub) {
  return el('div', 'empty-state',
    '<div class="es-icon">' + EMPTY_ICONS[icon] + '</div>' +
    '<div class="es-title">' + esc(title) + '</div>' +
    (sub ? '<div class="es-sub">' + esc(sub) + '</div>' : ''));
}

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
  playerError: false,
  playInfo: null,       // последний ответ /play
  hls: null,
  qualityH: null,       // выбранная высота потока (null = Авто)
  progressTimer: null,
  playRestart: false,   // «Смотреть» с начала, игнорируя позицию resume
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
  autoNext: null,       // {s,e,left,cur,timer} — отсчёт автоперехода к след. серии
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

/* data-bg/data-grad — ленивая подгрузка постеров: карточка рождается с
   фолбэк-градиентом, а картинку выставляет hydrateVisible(), когда она
   приближается к вьюпорту. Все постеры разом (40+ на главной) душат слабые
   ТВ на сетевых запросах и декодировании. wide-бэкдропы (1–6 МБ) — только
   hero/«Продолжить просмотр»/фон детальной: t.backdrop || t.poster */
function artAttrs(url, gradCss) {
  if (!url) return '';
  return ' data-bg="' + esc(url) + '"' + (gradCss ? ' data-grad="' + esc(gradCss) + '"' : '');
}

function hydrateVisible() {
  var vh = window.innerHeight || 1080;
  var vw = window.innerWidth || 1920;
  var els = document.querySelectorAll('[data-bg]');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var r = e.getBoundingClientRect();
    if (r.bottom < -vh * 0.6 || r.top > vh * 1.6 ||
        r.right < -vw * 0.2 || r.left > vw * 1.2) continue;
    var g2 = e.dataset.grad;
    e.style.background = 'url("' + e.dataset.bg + '") center/cover' + (g2 ? ', ' + g2 : '');
    e.removeAttribute('data-bg');
    e.removeAttribute('data-grad');
  }
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

/* Тот же timestamp человеческим языком: «сегодня», «вчера», «N дн. назад» */
function fmtRel(ts) {
  var n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  var d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  function dayStart(x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); }
  var diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diff <= 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  if (diff < 7) return diff + ' дн. назад';
  return fmtTs(ts);
}

function kpBadge(t) {
  /* показываем только IMDb: рейтинг Кинопоиска для пользователя неважен */
  if (t.imdb == null) return '';
  return '<span class="rate imdb">IMDb ' + t.imdb.toFixed(1) + '</span>';
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
  t.bookmarks = d.bookmarks || [];
  t.folders = d.bookmark_folders || [];
  /* точка возобновления ЭТОГО устройства (сезон/серия/позиция) с бэкенда */
  t.resume = d.resume || null;
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
    '<div class="poster-art" style="background:' + grad(t) + '"' + artAttrs(t.poster, grad(t)) + '>' +
    (t.q4k ? '<div class="badge4k">4K</div>' : '') +
    (t.newEpisodes ? '<div class="badge-new">' + t.newEpisodes + ' нов.</div>' : '') +
    '</div>' +
    '<div class="card-title">' + esc(t.name) + '</div>' +
    '<div class="card-sub">' + (t.year || '') + (t.imdb != null ? ' · ★ <b>' + t.imdb.toFixed(1) + '</b>' : '') + '</div>';
  return c;
}

function continueCard(t) {
  var c = el('div', 'card focusable');
  c.dataset.kind = 'watch';
  c.dataset.id = t.id;
  var g = grad(t, 140);
  var sub = t.subtitle || 'Продолжить просмотр';
  if (t.media && t.media.season != null) {
    /* как в истории: «Сезон · Серия» точки возобновления */
    sub = 'Сезон ' + t.media.season + ' · Серия ' + t.media.number;
  }
  c.innerHTML =
    '<div class="cw-art" style="background:' + g + '"' + artAttrs(t.backdrop || t.poster, g) + '>' +
    '<div class="cw-shade"></div>' +
    '<div class="cw-play">▶</div>' +
    '<div class="cw-name">' + esc(t.name) + '</div>' +
    '<div class="cw-progress"><i style="width:' + t.progressPct + '%"></i></div>' +
    '</div>' +
    '<div class="card-sub">' + esc(sub) + '</div>';
  return c;
}

function collectionCard(col) {
  var c = el('div', 'card focusable');
  c.dataset.kind = 'collection';
  c.dataset.id = col.id;
  c.dataset.name = col.title;
  c.innerHTML =
    '<div class="col-art"' + artAttrs(col.poster, '') + '>' +
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

/* Большой баннер главной: кандидаты — «Новинки» с широким фоном (до 5).
   Баннер ротирует их раз в ~10 с, меняя содержимое на месте — фокус и
   прокрутка экрана не трогаются */
function heroCandidates(home) {
  var fresh = ((home.rails || []).filter(function (r) { return r.id === 'fresh'; })[0] || {}).items || [];
  var out = [];
  fresh.forEach(function (raw) {
    if (out.length >= 5) return;
    var t = adaptCard(raw);
    if (!t.backdrop) return;
    remember(t);
    out.push(t);
  });
  if (!out.length && fresh.length) {
    var first = adaptCard(fresh[0]);
    remember(first);
    out.push(first);
  }
  return out;
}

function heroNode(f) {
  var hg = grad(f, 115);
  var hero = el('section', 'hero vrow');
  hero.innerHTML =
    '<div class="hero-bg" style="background:' + hg + '"' + artAttrs(f.backdrop || f.poster, hg) + '></div>' +
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
  FEATURED_ID = f.id;
  hero.dataset.id = f.id;
  return hero;
}

var heroRotation = { items: [], ix: 0, timer: null };

function rotateHero() {
  var items = heroRotation.items;
  var hero = document.querySelector('#home-content .hero');
  if (!items.length || !hero) return;
  heroRotation.ix = (heroRotation.ix + 1) % items.length;
  var f = items[heroRotation.ix];
  FEATURED_ID = f.id;
  hero.dataset.id = f.id;
  var art = f.backdrop || f.poster;
  var g = grad(f, 115);
  hero.querySelector('.hero-bg').style.background =
    art ? 'url("' + art + '") center/cover, ' + g : g;
  hero.querySelector('.hero-tag').textContent = typeLabel(f);
  hero.querySelector('h1').textContent = f.name;
  hero.querySelector('.meta').innerHTML =
    kpBadge(f) +
    (f.year ? '<span>' + f.year + '</span>' : '') +
    (f.q4k ? '<span class="uhd">4K</span>' : '');
}

function startHeroRotation() {
  stopHeroRotation();
  heroRotation.timer = setInterval(function () {
    /* крутим баннер только на видимой главной */
    if (state.screen === 'home') rotateHero();
  }, 10000);
}

function stopHeroRotation() {
  if (heroRotation.timer) clearInterval(heroRotation.timer);
  heroRotation.timer = null;
}

function renderHome() {
  renderNav();
  var c = $('#home-content');
  c.innerHTML = '';
  c.style.transform = 'translateY(0)';

  var rails = (DB.home && DB.home.rails) || [];
  var railById = {};
  rails.forEach(function (r) { railById[r.id] = r; });

  var featured = heroRotation.items[heroRotation.ix] || null;
  if (featured) c.appendChild(heroNode(featured));

  rails.forEach(function (r) {
    if (r.id === 'continue') {
      /* карточка с точкой возобновления: прогресс > 0 либо (между сериями)
         указатель на следующую серию с нулевой позицией */
      var items = r.items.map(adaptCard).filter(function (t) { return t.progressPct > 0 || t.media; });
      items.forEach(remember);
      if (items.length) c.appendChild(rail('Продолжить просмотр', items.map(continueCard)));
    } else {
      var cards = r.items.map(adaptCard);
      cards.forEach(remember);
      if (!cards.length) return; /* рельса пустая — не рисуем её вовсе */
      cards = cards.slice(0, HOME_RAIL_LIMIT);
      c.appendChild(rail(r.title, cards.map(posterCard)));
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
  var g = grad(t, 200);
  c.dataset.s = state.season;
  c.dataset.e = e.n - 1;
  c.innerHTML =
    '<div class="ep-art" style="background:' + g + '"' + artAttrs(e.thumbnail, g) + '>' +
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

/* Точка возобновления считается живой, пока просмотр не завершён: на 100%
   «продолжать» нечего — дальше работает обычная кнопка «Смотреть» */
function hasResume(t) {
  return !!(t && t.resume && t.resume.progress > 0 && t.resume.progress < 100);
}

function resumeButton(t) {
  if (!hasResume(t)) return '';
  var label = '▶ Продолжить просмотр';
  if (t.resume.season != null) {
    label += '<span class="b-ep">Сезон ' + t.resume.season + ' · Серия ' + t.resume.number + '</span>';
  }
  return '<button class="btn primary focusable" data-act="resume">' + label + '</button>';
}

/* Открыть плеер на серии, где остановились: номера сезона/серии из resume
   (или media карточки «Продолжить просмотр») переводим в индексы загруженной
   карточки; без них — обычный запуск (фильм сам встанет на позицию) */
async function playResume(id) {
  var t = byId(id);
  if (!t || !t.detail) {
    try {
      t = await loadDetail(id);
    } catch (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Не удалось открыть карточку: ' + e.message);
      return;
    }
  }
  var m = t.resume || t.media;
  if (!m || m.season == null || !t.seasons) return openPlayer(id);
  for (var i = 0; i < t.seasons.length; i++) {
    if (t.seasons[i].n !== m.season) continue;
    var eps = t.seasons[i].episodes;
    for (var j = 0; j < eps.length; j++) {
      if (eps[j].n === m.number) return openPlayer(id, i, j);
    }
    /* серия не нашлась (перенумеровали) — хотя бы нужный сезон */
    return openPlayer(id, i, null);
  }
  return openPlayer(id);
}

function renderDetail() {
  var t = state.title;
  var s = $('#screen-detail');
  var dbg = grad(t, 120);
  var dpg = grad(t);
  s.innerHTML =
    '<div class="detail-backdrop" style="background:' + dbg + '"' + artAttrs(t.backdrop || t.poster, dbg) + '></div>' +
    '<div class="detail-fade"></div>' +
    '<div id="detail-scroll"><div id="detail-content" class="scroll-content"></div></div>';
  var c = $('#detail-content');

  var main = el('section', 'detail-main vrow');
  main.innerHTML =
    '<div class="d-poster" style="background:' + dpg + '"' + artAttrs(t.poster, dpg) + '>' + (t.poster ? '' : '<div class="poster-name">' + esc(t.name) + '</div>') + '</div>' +
    '<div class="d-info">' +
    '<h1>' + esc(t.name) + '</h1>' +
    '<div class="meta">' + kpBadge(t) +
    (t.year ? '<span>' + t.year + '</span>' : '') +
    '<span>' + esc(typeLabel(t)) + '</span>' +
    (t.q4k ? '<span class="uhd">4K</span>' : '') +
    '</div>' +
    '<div class="d-btns">' +
    resumeButton(t) +
    '<button class="btn' + (hasResume(t) ? '' : ' primary') + ' focusable" data-act="watch">▶ Смотреть</button>' +
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

/* Стандартные классы вместо «сырых» высот манифеста: KP режет ряды под
   исходник (876p/960p — это кропнутый 1080p), и список «876p, 960p, 1080p»
   только путал. Ярлык один на класс; выбор класса пинит его старший ряд */
var QUALITY_CLASSES = [
  [2000, '4K'],
  [1200, '2K'],
  [800, 'FHD'],
  [600, 'HD'],
  [0, 'SD']
];

function qualityLabel(h) {
  for (var i = 0; i < QUALITY_CLASSES.length; i++) {
    if (h >= QUALITY_CLASSES[i][0]) return QUALITY_CLASSES[i][1];
  }
  return 'SD';
}

/* Уровни hls.js, сгруппированные в классы: [{label, height, level}],
   от тяжёлых к лёгким; представитель класса — самый высокий его ряд */
function qualityClasses(levels) {
  var byLabel = {};
  var out = [];
  levels.forEach(function (lv, i) {
    if (!lv.height) return;
    var label = qualityLabel(lv.height);
    if (!byLabel[label]) {
      byLabel[label] = { label: label, height: lv.height, level: i };
      out.push(byLabel[label]);
    } else if (lv.height > byLabel[label].height) {
      byLabel[label].height = lv.height;
      byLabel[label].level = i;
    }
  });
  out.sort(function (a, b) { return b.height - a.height; });
  return out;
}

/* Старые сохранённые выборы («1080p», «876p») переводим в классы;
   новые («FHD», «4K») проходят как есть */
function qualityPrefLabel(saved) {
  if (/^\d+p$/.test(saved)) return qualityLabel(parseInt(saved, 10));
  return saved;
}

/* Дефолт — 1080p: точное совпадение, иначе ближайший ряд НИЖЕ (на слабом
   канале лучше чуть легче), и лишь когда ниже пусто — самый лёгкий из
   верхних. Раньше без точного 1080p пинился максимум — на 4K-only
   манифестах это был 2160p без всякого ABR, отсюда «4K вечно грузится» */
function pickDefaultLevel(levels) {
  var below = -1, above = -1;
  for (var i = 0; i < levels.length; i++) {
    var h = levels[i].height || 0;
    if (h === 1080) return i;
    if (h < 1080 && (below < 0 || h > (levels[below].height || 0))) below = i;
    if (h > 1080 && (above < 0 || h < (levels[above].height || 0))) above = i;
  }
  return below >= 0 ? below : above;
}

/* Стартовое качество: сохранённый вручную класс (держим между сериями),
   иначе обычный дефолт. «Авто» — оставляем адаптивный режим как есть */
function applyQualityPref(hls) {
  var levels = hls.levels || [];
  if (!levels.length) return;
  var saved = trackPref('quality');
  if (saved === 'Авто') { state.qualityH = null; return; }
  if (saved) {
    var label = qualityPrefLabel(saved);
    var classes = qualityClasses(levels);
    for (var i = 0; i < classes.length; i++) {
      if (classes[i].label === label) {
        hls.currentLevel = classes[i].level;
        state.qualityH = classes[i].height;
        return;
      }
    }
  }
  /* сохранённый класс в этом манифесте отсутствует — дефолт.
     qualityH не трогаем: это стартовый пин уровня, а не ручной выбор —
     иначе попап качества показывал бы «FHD ✓» в режиме «Авто» */
  var ix = pickDefaultLevel(levels);
  if (ix >= 0) {
    hls.currentLevel = ix;
  }
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

/* Неустранимая ошибка плеера (нативный режим, а у hls.js исчерпана
   лестница восстановления): вместо чёрного экрана — оверлей с действием */
function showPlayerError() {
  state.playerError = true;
  setBuffering(false);
  var e = $('#player-error');
  if (e) e.classList.remove('hidden');
}
function hidePlayerError() {
  state.playerError = false;
  var e = $('#player-error');
  if (e) e.classList.add('hidden');
}

function stopPlayback() {
  state.playing = false;
  autoNextStop();
  setBuffering(false);
  hidePlayerError();
  clearInterval(state.progressTimer);
  state.progressTimer = null;
  if (state.hls) {
    try { state.hls.destroy(); } catch (e) {}
    state.hls = null;
  }
  var video = playerVideo();
  video.pause();
  /* сброс src освобождает буфер: без этого <video> держит докачанные
     мегабайты, а память ТВ ограничена */
  try { video.removeAttribute('src'); video.load(); } catch (e) {}
  Array.prototype.forEach.call(video.querySelectorAll('track'), function (t) { t.remove(); });
}

/* Индикатор буферизации: «замерший кадр» без спиннера на слабой сети
   выглядит как зависший плеер */
var bufferingHintTimer = null;
function setBuffering(on) {
  var b = $('#player-buffering');
  if (b) b.classList.toggle('hidden', !on);
  /* текст под крутилкой, если буферизация дольше ~5 с: без него «замерший
     кадр» на слабой сети неотличим от зависшего плеера */
  clearTimeout(bufferingHintTimer);
  bufferingHintTimer = null;
  var h = $('#buffering-hint');
  if (!h) return;
  if (on) {
    bufferingHintTimer = setTimeout(function () {
      h.classList.remove('hidden');
    }, 5000);
  } else {
    h.classList.add('hidden');
  }
}

/* Автопереход к следующей серии: компактная плашка у нижней кромки с
   отсчётом и кнопками «Смотреть»/«Отмена».
   Любая серия сериала завершается через ended → отсчёт 5 с → openPlayer */
function autoNextStart() {
  var t = state.title;
  var nxt = t && isSerial(t) ? nextEpisodeIndex() : null;
  if (!nxt) {
    /* конец фильма или последней серии: чёрный экран с тостом выглядел как
       зависание — возвращаемся на карточку тайтла */
    stopPlayback();
    if (t) openDetail(t.id); else goBack();
    return;
  }
  state.autoNext = { s: nxt.s, e: nxt.e, total: 5, left: 5, cur: 0 };
  renderAutoNext();
  /* тик 250 мс, чтобы полоса отсчёта двигалась плавно: CSS-переходы на ТВ
     отключены (.tv), поэтому ширину крутит JS */
  state.autoNext.timer = setInterval(autoNextTick, 250);
}

function autoNextTick() {
  var an = state.autoNext;
  if (!an) return;
  an.left = Math.round((an.left - 0.25) * 100) / 100;
  if (an.left <= 0) { autoNextRun(); return; }
  renderAutoNext();
}

function renderAutoNext() {
  var an = state.autoNext;
  if (!an) return;
  /* какая серия дальше — «Далее: Сезон 2 · Серия 1 — Название», иначе
     отсчёт висел без контекста */
  var t = state.title;
  var se = t && t.seasons && t.seasons[an.s];
  var ep = se && se.episodes[an.e];
  var what = (se && ep) ? 'Сезон ' + se.n + ' · Серия ' + ep.n : 'Следующая серия';
  if (ep && ep.title) what += ' — ' + ep.title;
  var line = document.querySelector('#player-autonext .an-text');
  if (line) line.textContent = 'Далее: ' + what;
  var num = document.getElementById('an-count');
  if (num) num.textContent = Math.ceil(an.left);
  var fill = document.getElementById('an-fill');
  if (fill) fill.style.width = Math.max(0, an.left / an.total * 100) + '%';
  var btns = document.querySelectorAll('#player-autonext .btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('focused', i === an.cur);
  }
  document.getElementById('player-autonext').classList.remove('hidden');
}

function autoNextRun() {
  var an = state.autoNext;
  if (!an || !state.title) return;
  var id = state.title.id;
  autoNextStop();
  openPlayer(id, an.s, an.e);
}

function autoNextStop() {
  var an = state.autoNext;
  if (an && an.timer) clearInterval(an.timer);
  state.autoNext = null;
  var p = document.getElementById('player-autonext');
  if (p) p.classList.add('hidden');
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
  /* главная строка — всегда имя тайтла: /play отдаёт в title название
     серии («Недотёпство заразно»), и имя шоу терялось */
  var name = (t && t.name) || info.title || '';
  $('#pv-title').textContent = name;
  if (info.season != null) {
    var line = 'Сезон ' + info.season + ' · Серия ' + info.episode;
    if (info.title && info.title !== name) line += ' · ' + info.title;
    $('#pv-ep').textContent = line;
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
  var opts = [{ kind: 'off', label: 'Выкл', lang: null }];
  var seen = { 'Выкл': true };
  var i, label, lang;
  if (state.hls) {
    var list = state.hls.subtitleTracks || [];
    for (i = 0; i < list.length; i++) {
      label = list[i].name || ('Субтитры ' + (i + 1));
      lang = list[i].lang || null;
      if (!seen[label]) { opts.push({ kind: 'embedded', index: i, label: label, lang: lang }); seen[label] = true; }
    }
  } else {
    Array.prototype.forEach.call(playerVideo().textTracks, function (t) {
      if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
      label = t.label || t.language;
      lang = t.language || null;
      if (label && !seen[label]) { opts.push({ kind: 'embedded', index: 0, label: label, lang: lang }); seen[label] = true; }
    });
  }
  (state.playInfo.subtitles || []).forEach(function (s, ix) {
    label = seen[s.label] ? s.label + ' (файл)' : s.label;
    if (!seen[label]) { opts.push({ kind: 'external', index: ix, label: label, lang: s.lang || null }); seen[label] = true; }
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

/* Имена языков для группировки дорожек (ISO-639-1 и -2, как приходят от
   манифеста и от API). Неизвестный код показываем как есть, без кода — «Другие» */
var LANG_NAMES = {
  ru: 'Русский', rus: 'Русский', en: 'Английский', eng: 'Английский',
  uk: 'Украинский', ukr: 'Украинский', be: 'Белорусский', bel: 'Белорусский',
  kk: 'Казахский', kaz: 'Казахский', zh: 'Китайский', chi: 'Китайский',
  ja: 'Японский', jpn: 'Японский', ko: 'Корейский', kor: 'Корейский',
  de: 'Немецкий', ger: 'Немецкий', deu: 'Немецкий', fr: 'Французский', fre: 'Французский',
  es: 'Испанский', spa: 'Испанский', it: 'Итальянский', ita: 'Итальянский',
  pt: 'Португальский', por: 'Португальский', pl: 'Польский', pol: 'Польский',
  tr: 'Турецкий', tur: 'Турецкий', ar: 'Арабский', ara: 'Арабский',
  hi: 'Хинди', hin: 'Хинди', th: 'Тайский', tha: 'Тайский',
  vi: 'Вьетнамский', vie: 'Вьетнамский', cs: 'Чешский', cze: 'Чешский',
  bg: 'Болгарский', bul: 'Болгарский', hu: 'Венгерский', hun: 'Венгерский',
  nl: 'Голландский', dut: 'Голландский', sv: 'Шведский', swe: 'Шведский',
  da: 'Датский', dan: 'Датский', fi: 'Финский', fin: 'Финский',
  no: 'Норвежский', nor: 'Норвежский', ro: 'Румынский', rum: 'Румынский',
  el: 'Греческий', ell: 'Греческий', gre: 'Греческий',
  he: 'Иврит', heb: 'Иврит', id: 'Индонезийский', ind: 'Индонезийский',
  ms: 'Малайский', may: 'Малайский', fa: 'Персидский', per: 'Персидский',
  et: 'Эстонский', est: 'Эстонский', lv: 'Латышский', lav: 'Латышский',
  lt: 'Литовский', lit: 'Литовский', sr: 'Сербский', srp: 'Сербский',
  hr: 'Хорватский', hrv: 'Хорватский', sl: 'Словенский', slv: 'Словенский',
  sk: 'Словацкий', slo: 'Словацкий', sq: 'Албанский', sqi: 'Албанский',
  hy: 'Армянский', arm: 'Армянский', az: 'Азербайджанский', aze: 'Азербайджанский',
  ka: 'Грузинский', geo: 'Грузинский', uz: 'Узбекский', uzb: 'Узбекский',
  tg: 'Таджикский', tgk: 'Таджикский', mn: 'Монгольский', mon: 'Монгольский'
};

function langName(code) {
  if (!code) return 'Другие';
  var key = String(code).toLowerCase();
  return LANG_NAMES[key] || String(code).toUpperCase();
}

/* Порядок пунктов попапа (аудио/субтитры): безъязычные первыми («Выкл»,
   «По умолчанию»), затем группы по языку — русская всегда первая, остальные
   в порядке первого появления; внутри группы исходный порядок сохраняется.
   Возвращает перестановку исходных индексов: seq[позиция на экране] =
   исходный индекс пункта. Список сортируется целиком — курсор ходит по
   экранному порядку и никуда не «прыгает» */
function groupOrder(langs) {
  var flat = [];
  var groups = {}, order = [];
  langs.forEach(function (lang, i) {
    if (!lang) { flat.push(i); return; }
    var g = langName(lang);
    if (!groups[g]) { groups[g] = []; order.push(g); }
    groups[g].push(i);
  });
  var ru = order.indexOf('Русский');
  if (ru > 0) { order.splice(ru, 1); order.unshift('Русский'); }
  var seq = flat.slice();
  order.forEach(function (g) { seq = seq.concat(groups[g]); });
  return seq;
}

/* Строки попапа по уже упорядоченным пунктам: при нескольких языковых
   группах между ними вставляются неселективные заголовки. i пункта — его
   позиция в items (экранный порядок); выбор маппится на исходный индекс
   дорожки через origs из popupConfig */
function groupRows(items, langs) {
  var distinct = {};
  langs.forEach(function (lang) { if (lang) distinct[langName(lang)] = 1; });
  var multi = Object.keys(distinct).length > 1;
  var rows = [], lastG = null;
  items.forEach(function (label, i) {
    var g = langs[i] ? langName(langs[i]) : null;
    if (multi && g && g !== lastG) rows.push({ head: g });
    if (g) lastG = g;
    rows.push({ label: label, i: i });
  });
  return rows;
}

function popupConfig(kind) {
  if (kind === 'subs') {
    var opts = subtitleOptions();
    var langs = opts.map(function (o) { return o.lang; });
    var seqS = groupOrder(langs);
    var items = seqS.map(function (oi) { return opts[oi].label; });
    return {
      title: 'Субтитры', items: items, origs: seqS, current: state.subs,
      rows: groupRows(items, seqS.map(function (oi) { return langs[oi]; }))
    };
  }
  if (kind === 'audio') {
    var tracks = state.hls && state.hls.audioTracks ? state.hls.audioTracks : [];
    if (!tracks.length) return { title: 'Аудиодорожка', items: ['По умолчанию'], origs: [0], current: 'По умолчанию' };
    var langsA = tracks.map(function (tr) { return tr.lang || null; });
    var seqA = groupOrder(langsA);
    /* безымянные дорожки нумеруются по порядку внутри своей языковой
       группы — без исходных «прыгающих» номеров манифеста */
    var counters = {};
    var names = seqA.map(function (oi) {
      var tr = tracks[oi];
      if (tr.name) return tr.name;
      var g = langsA[oi] ? langName(langsA[oi]) : '';
      counters[g] = (counters[g] || 0) + 1;
      return 'Дорожка ' + counters[g];
    });
    var curIdx = seqA.indexOf(state.hls.audioTrack);
    if (curIdx < 0) curIdx = 0;
    return {
      title: 'Аудиодорожка', items: names, origs: seqA, currentIdx: curIdx,
      current: names[curIdx],
      rows: groupRows(names, seqA.map(function (oi) { return langsA[oi]; }))
    };
  }
  if (kind === 'quality') {
    if (!state.hls || !state.hls.levels || !state.hls.levels.length) {
      return { title: 'Качество', items: ['Авто'], current: 'Авто' };
    }
    var classes = qualityClasses(state.hls.levels);
    var qlabels = ['Авто'].concat(classes.map(function (c) { return c.label; }));
    return {
      title: 'Качество',
      items: qlabels,
      current: state.qualityH ? qualityLabel(state.qualityH) : 'Авто'
    };
  }
  return null;
}

function openPopup(kind) {
  state.popup = kind;
  var cfg = popupConfig(kind);
  state.popupIdx = cfg.currentIdx != null ? cfg.currentIdx : Math.max(0, cfg.items.indexOf(cfg.current));
  renderPopup();
}

function renderPopup() {
  var cfg = popupConfig(state.popup);
  if (!cfg) return;
  var rows = cfg.rows || cfg.items.map(function (label, i) { return { label: label, i: i }; });
  var sel = cfg.currentIdx != null ? cfg.currentIdx : Math.max(0, cfg.items.indexOf(cfg.current));
  var p = $('#player-popup');
  p.innerHTML = '<div class="popup-title">' + esc(cfg.title) + '</div>' +
    '<div class="popup-scroll">' + rows.map(function (r) {
      if (r.head !== undefined) return '<div class="popup-head">' + esc(r.head) + '</div>';
      return '<div class="popup-item' + (r.i === sel ? ' sel' : '') + (r.i === state.popupIdx ? ' cur' : '') + '" data-i="' + r.i + '">' +
        esc(r.label) + (r.i === sel ? ' ✓' : '') + '</div>';
    }).join('') + '</div>';
  // список может не влезать в экран — держим текущий пункт в видимой зоне
  var sc = p.querySelector('.popup-scroll');
  var cur = sc.querySelector('.popup-item.cur');
  if (cur) sc.scrollTop = cur.offsetTop - (sc.clientHeight - cur.offsetHeight) / 2;
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
      state.hls.audioTrack = cfg.origs ? cfg.origs[i] : i;
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
        var classes = qualityClasses(state.hls.levels);
        for (var li = 0; li < classes.length; li++) {
          if (classes[li].label === value) {
            state.hls.currentLevel = classes[li].level;
            state.qualityH = classes[li].height;
            break;
          }
        }
      }
      saveTrackPref('quality', value);
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
   сам браузер (иначе «Ошибка воспроизведения» на HEVC-only тайтлах).
   Результат кэшируем: проверка создаёт video-элемент и не меняется
   в течение сессии */
var hevcCache = null;
function hevcSupported() {
  if (hevcCache !== null) return hevcCache;
  var ok = false;
  var profiles = ['hvc1.1.6.L93.B0', 'hvc1.2.4.L150.B0'];
  for (var i = 0; i < profiles.length; i++) {
    var mime = 'video/mp4; codecs="' + profiles[i] + '"';
    try {
      if (window.MediaSource && MediaSource.isTypeSupported(mime)) { ok = true; break; }
    } catch (e) {}
    try {
      if (document.createElement('video').canPlayType(mime)) { ok = true; break; }
    } catch (e) {}
  }
  hevcCache = ok;
  return ok;
}

async function openPlayer(id, sIdx, eIdx, restart) {
  autoNextStop();
  var t = byId(id);
  if (!t || !t.detail) {
    try {
      t = await loadDetail(id);
    } catch (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Не удалось открыть карточку: ' + e.message);
      return;
    }
  }
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

  var info;
  try {
    info = await api('/play/' + id + query +
      (query ? '&' : '?') + 'hevc=' + (hevcSupported() ? 1 : 0));
  } catch (e) {
    if (e && e.code === 'not_registered') { showRegister(); return; }
    toast('Не удалось начать воспроизведение: ' + e.message);
    return;
  }
  var hlsPromise = ensureHls();
  state.playInfo = info;
  state.playRestart = !!restart;
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
     Нативный HLS — фолбэк для устройств без MSE и после неисправимой ошибки
     hls.js (например, неподдерживаемый кодек в манифесте) */
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls({
      /* слабые ТВ тонут в декодировании длинного задела — ограничиваем
         сзади; спереди наоборот держим подушку побольше: на медленном канале
         буфер по умолчанию (30 с) постоянно сдыхает на грани */
      backBufferLength: 90,
      maxBufferLength: 60
    });
    state.hls = hls;
    state.hlsRecovered = 0;
    /* иначе hls.js сам включает дорожку с DEFAULT=YES из манифеста, и
       субтитры появляются вопреки «Выкл» в меню */
    hls.subtitleDisplay = false;

    /* Фатальные ошибки лечим по нарастающей: сетевую — перезапуском
       загрузки, медиа — recoverMediaError (до двух раз), и только потом
       уходим на нативный плеер — с восстановлением позиции, а не с нуля */
    var fallbackNative = function () {
      var pos = video.currentTime;
      try { hls.destroy(); } catch (err) {}
      state.hls = null;
      video.src = info.url;
      restoreOnMeta(video);
      if (pos > 0) {
        var onPos = function () {
          video.removeEventListener('loadedmetadata', onPos);
          try { video.currentTime = pos; } catch (err) {}
        };
        video.addEventListener('loadedmetadata', onPos);
      }
      var p = video.play();
      if (p && p.catch) { p.catch(function () {}); }
      toast('Включён режим совместимости — выбор качества и дорожек недоступен');
    };

    hls.on(Hls.Events.ERROR, function (e, d) {
      if (!d || !d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
        try { hls.startLoad(); return; } catch (err) { /* ниже */ }
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && state.hlsRecovered < 2) {
        state.hlsRecovered++;
        try { hls.recoverMediaError(); return; } catch (err) { /* ниже */ }
      }
      fallbackNative();
    });
    hls.loadSource(info.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      applyQualityPref(hls);
      restoreTracks();
      updateControlLabels();
    });
  } else {
    video.src = info.url;
    restoreOnMeta(video);
  }

  buildPlayer();

  /* restart («Смотреть» при живой кнопке «Продолжить») игнорирует позицию —
     старт с начала; иначе встаём на точку возобновления */
  if (info.position && !state.playRestart) {
    var onMeta = function () {
      video.removeEventListener('loadedmetadata', onMeta);
      if (video.currentTime < info.position - 5) video.currentTime = info.position;
    };
    video.addEventListener('loadedmetadata', onMeta);
  }

  state.playing = true;
  setBuffering(true);
  var playPromise = video.play();
  if (playPromise && playPromise.catch) { playPromise.catch(function () { /* autoplay policies */ }); }

  clearInterval(state.progressTimer);
  state.progressTimer = null;
  if (info.content_id) {
    /* на паузе прогресс не движется — слать нечего; финальный отчёт шлют
       обработчики pause/ended */
    state.progressTimer = setInterval(function () {
      var v = playerVideo();
      if (!v.paused && !v.ended) reportProgress();
    }, 10000);
  }
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
      /* бэкенд считает % и убирает досмотренное из «Продолжить просмотр» */
      duration: Math.floor(video.duration || info.duration || 0),
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
  if (!row || !row.length) {
    /* пустой экран (например, /home ответил пустыми рельсами): фокус падает
       на ближайшую непустую строку — иначе не фокусируется ничего и пульт
       молчит */
    var nr = -1;
    for (var ri = f.r; ri >= 0; ri--) {
      if (rows[ri] && rows[ri].length) { nr = ri; break; }
    }
    if (nr < 0) {
      for (var rj = f.r + 1; rj < rows.length; rj++) {
        if (rows[rj] && rows[rj].length) { nr = rj; break; }
      }
    }
    if (nr < 0) return;
    f.r = nr;
    row = rows[nr];
  }
  f.c = Math.max(0, Math.min(f.c, row.length - 1));
  var elm = row[f.c];
  elm.classList.add('focused');
  if (scr === 'player' || scr === 'register') return;
  /* подгружаем постеры, приближающиеся к вьюпорту */
  hydrateVisible();

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
  /* то же самое по горизонтали: лента сдвигается только когда карточка
     выходит за правый/левый край. Видимая ширина зависит от экрана:
     браузерные смещены боковой панелью, деталь — нет. Строка табов
     (сезоны/папки закладок) скроллится так же, если не влезает */
  var track = elm.closest('.track') || elm.closest('.tabs');
  if (track) {
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
  /* сетка папки закладок: следующая страница у нижних строк */
  if (scr === 'bookmarks' && !bmState.loading && bmState.hasMore &&
      bmState.folder === state.bookmarkFolder &&
      f.r >= rows.length - 2) {
    loadBookmarksPage();
  }
  /* лента истории: следующая страница у нижних строк */
  if (scr === 'history' && !historyState.loading && historyState.hasMore &&
      f.r >= rows.length - 2) {
    loadHistoryPage(historyToken, historyState.nextPage);
  }
  /* результаты поиска: догрузка страниц, пока они соответствуют строке запроса */
  if (scr === 'search' && state.searchResults && !searchState.loading &&
      searchState.hasMore && searchState.query === state.query.trim() &&
      f.r >= rows.length - 2) {
    loadSearchPage(searchState.page + 1, true);
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
  /* вход мог быть удерживаемой клавишей — её автоповторы гасим в keydown,
     иначе удержание ↑ «проскакивает» текущий раздел до первого пункта меню */
  menuRepeatGuard = true;
}

/* Автоповтор клавиши, которой вошли в боковое меню, не листает его пункты.
   Взводится в enterMenu, сбрасывается первым «свежим» (не repeat) keydown —
   каждое новое удержание начинается с него, так что осознанное листание
   пунктов меню с автоповтором работает как раньше */
var menuRepeatGuard = false;

/* выход из меню обратно в контент — на запомненную позицию */
function leaveMenu(rows, f) {
  f.r = Math.min(state.lastNavRow[state.screen] || 1, rows.length - 1);
  f.c = Math.min(state.lastNavCol[state.screen] || 0, rows[f.r].length - 1);
}

/* Геометрический выбор клавиши в соседнем ряду клавиатуры: фокус идёт
   на ключ, ближайший по горизонтали к текущему, а не на ключ с тем же
   индексом (ряды разной длины и ширины — «столбцов» у клавиатуры нет).
   Повторяет D-pad-навигацию Android TV (FocusFinder): кандидат должен
   лежать строго в направлении движения, перекрывающие «луч» текущего
   ключа бьют неперекрывающих, дальше веса 13*gap² + offset², как у
   FocusFinder.getWeightedDistanceFor. Возвращает индекс в row или -1 */
function nearestKbCol(fromEl, row, dy) {
  var fr = fromEl.getBoundingClientRect();
  var fx = (fr.left + fr.right) / 2;
  var best = -1, bestScore = Infinity;
  for (var i = 0; i < row.length; i++) {
    var r = row[i].getBoundingClientRect();
    if (dy < 0 && r.bottom >= fr.top) continue;
    if (dy > 0 && r.top <= fr.bottom) continue;
    var gap = dy < 0 ? fr.top - r.bottom : r.top - fr.bottom;
    var off = Math.abs((r.left + r.right) / 2 - fx);
    var overlap = r.left < fr.right && r.right > fr.left;
    var score = (overlap ? 0 : 1e9) + 13 * gap * gap + off * off;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
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
         стандартные правила, колонка сохраняется; клавиатура — по геометрии:
         ряды разной ширины, сохранение индекса телепортировало фокус
         в противоположный край следующего ряда */
      var newRow = rows[r];
      var isRail = newRow.length && newRow[0].closest('.track');
      var geoCol = -1;
      if (!isRail && newRow.length) {
        var cur = rows[f.r][f.c];
        var inKb = cur && cur.closest && cur.closest('.kb');
        var toKb = newRow[0].closest && newRow[0].closest('.kb');
        if (inKb || toKb) geoCol = nearestKbCol(cur, newRow, dy);
      }
      f.r = r;
      f.c = isRail ? 0 : (geoCol >= 0 ? geoCol : Math.min(f.c, newRow.length - 1));
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
  /* экран, с которого открываем, запоминаем ДО await: спиннер-ветка ниже
     уже переключает на detail, и после await state.screen врёт (кажется
     переход detail → detail — старый тайтл пушится в стек и Back снова
     открывает предыдущую карточку) */
  var from = state.screen;
  var t = byId(id);
  if (!t || !t.detail) {
    /* пока /items/{id} в полёте, показываем экран детали со спиннером —
       иначе по «ОК» секунды ничего не происходит вообще */
    if (from !== 'detail') {
      var s = $('#screen-detail');
      s.innerHTML = '<div class="page-head"><h1>Загрузка…</h1></div>';
      ROWS.detail = [];
      switchScreen('detail');
    }
    try {
      t = await loadDetail(id);
    } catch (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Не удалось открыть карточку: ' + e.message);
      if (state.screen === 'detail' && !state.title) {
        switchScreen(from && from !== 'player' ? from : 'home');
      }
      return;
    }
  }
  if (from === 'detail' && state.title && state.title.id !== t.id) {
    /* переход карточка → карточка («Похожие»): запоминаем, откуда пришли,
       чтобы Back вернул на предыдущую карточку, а не застрял */
    state.detailStack.push({
      title: state.title,
      season: state.season,
      focus: { r: FOCUS.detail.r, c: FOCUS.detail.c },
    });
    if (state.detailStack.length > 10) state.detailStack.shift();
  } else if (from !== 'detail') {
    state.detailStack = [];
    state.prev = from;
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
  /* /home собирает ~7 upstream-запросов + обогащение «Продолжить просмотр» —
     на медленном канале до VPS дефолтных 25 с не хватало */
  return api('/home', { timeout: 40000 })
    .then(function (home) {
      DB.home = home;
      heroRotation.items = heroCandidates(home);
      heroRotation.ix = 0;
      renderHome();
      startHeroRotation();
      SECTION_RENDERED.home = true;
      FOCUS.home = { r: Math.min(1, ROWS.home.length - 1), c: 0 };
      markNavCurrent();
      applyFocus();
    })
    .catch(function (e) {
      SECTION_RENDERED.home = false;
      if (e && e.code === 'not_registered') { showRegister(); return; }
      renderHomeError(e.message);
    });
}

/* Плейсхолдеры, пока /home в полёте: пустой тёмный экран с одним меню
   на старте приложения выглядел сломанным */
function renderHomeSkeleton() {
  stopHeroRotation();
  renderNav();
  var c = $('#home-content');
  c.innerHTML = '';
  c.style.transform = 'translateY(0)';
  c.appendChild(el('section', 'hero skel skel-hero'));
  for (var i = 0; i < 3; i++) {
    var r = el('section', 'rail');
    r.appendChild(el('h2', 'skel skel-line', ''));
    var track = el('div', 'track');
    for (var j = 0; j < 6; j++) track.appendChild(el('div', 'skel skel-card'));
    r.appendChild(track);
    c.appendChild(r);
  }
  ROWS.home = [topRow()];
  FOCUS.home = { r: 0, c: 0 };
  markNavCurrent();
  applyFocus();
}

/* Сбой загрузки главной — инлайн-ошибка с кнопкой «Повторить», а не тост,
   который мигнёт и исчезнет */
function renderHomeError(message) {
  stopHeroRotation();
  renderNav();
  var c = $('#home-content');
  c.innerHTML = '';
  c.style.transform = 'translateY(0)';
  c.appendChild(el('div', 'page-head',
    '<h1>Главная</h1><div class="sub">Не удалось загрузить: ' + esc(message) + '</div>'));
  var retry = el('button', 'btn primary focusable', 'Повторить');
  retry.dataset.act = 'retry-home';
  var wrap = el('div', 'retry-wrap');
  wrap.appendChild(retry);
  c.appendChild(wrap);
  ROWS.home = [topRow(), [retry]];
  FOCUS.home = { r: 1, c: 0 };
  markNavCurrent();
  applyFocus();
}

/* ------------------------------- Каталог --------------------------------- */

/* токен поколения каталога: отсекает поздние ответы от предыдущего
   раздела/подборки, переиспользующих тот же #catalog-content */
var catalogToken = 0;

/* сколько карточек показываем в ленте каталога до «Смотреть все» */
var RAIL_LIMIT = 10;

/* сколько карточек показываем в лентах главной: ленты там смесь фильмов
   и сериалов, легко 40+ карточек — долистывание пультом до конца занимало
   минуты. Полные выдачи доступны в «Каталоге» */
var HOME_RAIL_LIMIT = 20;

/* Скелетон-заглушки, пока раздел грузится: на главной так было изначально,
   остальные экраны показывали текст «Загрузка…» */
function skelTrack(count) {
  var track = el('div', 'track');
  for (var i = 0; i < count; i++) track.appendChild(el('div', 'skel skel-card'));
  return track;
}

function catalogSkeleton() {
  var wrap = el('div', 'skel-wrap');
  for (var i = 0; i < 3; i++) {
    var r = el('section', 'rail' + (i === 0 ? ' rail-first' : ''));
    r.appendChild(el('h2', 'skel skel-line', ''));
    r.appendChild(skelTrack(6));
    wrap.appendChild(r);
  }
  return wrap;
}

function clearSectionSkeleton() {
  if (!state.sectionGrid) return;
  Array.prototype.forEach.call(
    state.sectionGrid.querySelectorAll('.skel-card'),
    function (sk) { sk.remove(); }
  );
}

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
  c.appendChild(catalogSkeleton());
  function clearSkeleton() {
    var sk = c.querySelector('.skel-wrap');
    if (sk) sk.remove();
  }

  var pending = 0, made = 0;
  function settle() {
    if (token !== catalogToken) return;
    pending--;
    if (pending > 0) return;
    clearSkeleton();
    if (!made) {
      /* ничего не загрузилось — даём повторить прямо на месте */
      delete SECTION_RENDERED['catalog:' + type];
      c.appendChild(el('div', 'page-head',
        '<div class="sub">Не удалось загрузить каталог.</div>'));
      var retry = el('button', 'btn primary focusable', 'Повторить');
      retry.dataset.act = 'retry-catalog';
      var wrap = el('div', 'retry-wrap');
      wrap.appendChild(retry);
      c.appendChild(wrap);
      rebuildRows('catalog', true);
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
    if (made === 1) clearSkeleton();
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
      if (made === 1) clearSkeleton();
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
  for (var si = 0; si < 10; si++) state.sectionGrid.appendChild(el('div', 'skel skel-card'));
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
        clearSectionSkeleton();
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
        clearSectionSkeleton();
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
      clearSectionSkeleton();
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
      clearSectionSkeleton();
      if (e && e.code === 'not_registered') { showRegister(); return; }
      if (page > 1) {
        toast('Не удалось загрузить ещё: ' + e.message);
      } else {
        state.sectionGrid.appendChild(el('div', 'card-sub', 'Ошибка загрузки: ' + esc(e.message)));
        var retry = el('button', 'btn primary focusable', 'Повторить');
        retry.dataset.act = 'retry-section';
        var wrap = el('div', 'retry-wrap');
        wrap.appendChild(retry);
        state.sectionGrid.appendChild(wrap);
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
      for (var i = 0; i < 10; i++) grid.appendChild(el('div', 'skel skel-col'));
      if (!collectionsState.loading) loadCollectionsPage(token);
    } else if (collectionsState.hasMore && !collectionsState.loading) {
      /* мягкая догрузка следующей страницы, пока пользователь смотрит список */
      loadCollectionsPage(token);
    }
    return;
  }

  for (var ci = 0; ci < 10; ci++) grid.appendChild(el('div', 'skel skel-col'));
  api('/collections/' + cur.id).then(function (data) {
    if (token !== collectionsToken || collectionsState.current !== cur) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.skel-col'), function (sk) { sk.remove(); });
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
      Array.prototype.forEach.call(grid.querySelectorAll('.skel-col'), function (sk) { sk.remove(); });
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
    ['ё', 'й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
    ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
    ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', '⌫'],
  ],
  en: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
  ],
  /* три ряда, как у букв — высота клавиатуры не меняется при переключении */
  digits: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '.', ',', ':', ';', '(', ')', '!', '?'],
    ['@', '#', '+', '=', '/', '\'', '"', '*', '%', '⌫'],
  ],
};

/* сохранённая раскладка клавиатуры (localStorage может быть недоступен
   в ТВ-вебвью — просто остаёмся на RU) */
function savedKbLang() {
  try {
    var l = localStorage.getItem('kptv.kbLang');
    return KB_LAYOUTS[l] ? l : 'ru';
  } catch (e) { return 'ru'; }
}

function renderSearch() {
  state.kbLang = savedKbLang();
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
  /* одна клавиша раскладки: по кругу RU → EN → 123, метка — текущая */
  [['layout', null], ['space', 'Пробел'], ['clear', 'Стереть всё'], ['go', 'Найти']]
    .forEach(function (pair) {
      var cls = 'kb-key focusable';
      var label = pair[1];
      if (pair[0] === 'layout') {
        label = state.kbLang === 'ru' ? 'RU' : state.kbLang === 'en' ? 'EN' : '123';
      }
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

/* Фокус на клавишу переключения раскладки. После перерисовки клавиатуры
   (r,c) прежнего элемента может не существовать — строки у раскладок разной
   длины, слепое сохранение индексов переносило фокус на другую клавишу */
function focusKbLayoutKey() {
  var rows = ROWS.search;
  for (var r = 0; r < rows.length; r++) {
    for (var c = 0; c < rows[r].length; c++) {
      var elm = rows[r][c];
      if (elm && elm.dataset && elm.dataset.kb === 'layout') {
        FOCUS.search = { r: r, c: c };
        applyFocus();
        return;
      }
    }
  }
  applyFocus();
}

function searchKey(key) {
  if (key.dataset.kb === 'go') { runSearch(false); return; }
  if (key.dataset.kb === 'space') { state.query += ' '; updateQueryBar(); scheduleLiveSearch(); return; }
  if (key.dataset.kb === 'clear') {
    state.query = '';
    state.searchResults = null;
    state.searchQuery = '';
    renderSearch();
    focusKbLayoutKey();
    return;
  }
  if (key.dataset.kb === 'layout') {
    state.kbLang = state.kbLang === 'ru' ? 'en' : state.kbLang === 'en' ? 'digits' : 'ru';
    try { localStorage.setItem('kptv.kbLang', state.kbLang); } catch (e) { /* ТВ-вебвью без storage */ }
    renderSearch();
    focusKbLayoutKey();
    return;
  }
  var k = key.dataset.key;
  if (k === '⌫') state.query = state.query.slice(0, -1);
  else state.query += k;
  updateQueryBar();
  scheduleLiveSearch();
}

/* Живой поиск: после паузы в наборе (700 мс, от 2 символов) результат
   подгружается сам — идти к кнопке «Найти» не обязательно. Фокус остаётся
   на клавиатуре, строка ввода не перерисовывается */
var searchTimer = null;
var searchState = { query: '', page: 0, items: [], hasMore: false, loading: false };

function scheduleLiveSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  if (state.query.trim().length < 2) {
    /* запрос стёрт или укорочен: результаты прошлого запроса больше не
       соответствуют строке — убираем их и показываем нейтральный экран */
    if (state.searchResults) {
      state.searchResults = null;
      state.searchQuery = '';
      renderSearch();
      focusKbLayoutKey();
    }
    return;
  }
  searchTimer = setTimeout(function () { runSearch(true); }, 700);
}

function runSearch(auto) {
  var q = state.query.trim();
  if (!q) { if (!auto) toast('Введите название'); return; }
  if (auto && state.searchQuery === q && state.searchResults) return;
  clearTimeout(searchTimer);
  searchTimer = null;
  if (!auto) toast('Ищем: ' + q);
  searchState = { query: q, page: 0, items: [], hasMore: true, loading: false };
  loadSearchPage(1, auto);
}

function loadSearchPage(page, auto) {
  /* пока запрос летит, может начаться новый поиск (searchState заменяется):
     захватываем свой объект, чтобы чужой ответ не затёр свежую выдачу */
  var st = searchState;
  if (st.loading) return;
  st.loading = true;
  api('/search?q=' + encodeURIComponent(st.query) + '&page=' + page)
    .then(function (res) {
      if (st !== searchState) return;
      st.loading = false;
      var items = (res.items || []).map(adaptCard);
      items.forEach(remember);
      st.items = page === 1 ? items : st.items.concat(items);
      st.page = page;
      st.hasMore = !!res.has_more;
      state.searchResults = st.items;
      state.searchQuery = st.query;
      renderSearch();
      if (auto) {
        applyFocus(); /* фокус остаётся на клавиатуре */
      } else {
        /* ручной «Найти» — сразу к результатам, если они есть */
        FOCUS.search = { r: 1, c: 0 };
        for (var i = 1; i < ROWS.search.length; i++) {
          var first = ROWS.search[i] && ROWS.search[i][0];
          if (first && first.dataset && first.dataset.kind) {
            FOCUS.search = { r: i, c: 0 };
            break;
          }
        }
        applyFocus();
      }
    })
    .catch(function (e) {
      if (st !== searchState) return;
      st.loading = false;
      if (e && e.code === 'not_registered') { showRegister(); return; }
      if (!auto || page === 1) toast('Ошибка поиска: ' + e.message);
    });
}

function renderSearchResults(c) {
  var items = state.searchResults;
  if (!items.length) {
    c.appendChild(emptyState('search', 'Ничего не нашлось',
      'Проверьте раскладку клавиатуры или измените запрос'));
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

/* Состояние пагинации активной папки: папки больше одной upstream-страницы
   догружаются у нижних строк сетки */
var bmState = { folder: null, page: 0, hasMore: false, loading: false };

function renderBookmarks() {
  var c = $('#bookmarks-content');
  c.innerHTML = '';
  c.appendChild(el('div', 'page-head', '<h1>Закладки</h1><div class="sub" id="bm-sub"></div>'));

  if (!state.bookmarkFolders.length) {
    c.appendChild(emptyState('bookmark', 'Закладок пока нет',
      'Откройте карточку фильма или сериала и нажмите «В закладки»'));
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
  var bgrid = el('div', 'grid');
  for (var bi = 0; bi < 5; bi++) bgrid.appendChild(el('div', 'skel skel-card'));
  c.appendChild(bgrid);

  bmState = { folder: state.bookmarkFolder, page: 0, hasMore: false, loading: false };
  buildBrowseRows('bookmarks');
  loadBookmarksPage();
}

function loadBookmarksPage() {
  if (bmState.loading || !state.bookmarkFolder) return;
  if (bmState.page > 0 && !bmState.hasMore) return;
  bmState.loading = true;
  var page = bmState.page + 1;
  /* пока запрос летит, экран мог переоткрыться (bmState заменяется) или
     папка сменилась: захватываем оба значения, чужой ответ выбрасываем */
  var bm = bmState;
  var folder = state.bookmarkFolder;
  api('/bookmarks/' + folder + '?page=' + page)
    .then(function (res) {
      if (bm !== bmState || folder !== state.bookmarkFolder) return;
      bm.loading = false;
      var grid = $('#bookmarks-content .grid');
      if (!grid) return;
      Array.prototype.forEach.call(
        grid.querySelectorAll('.skel-card, .card-sub'),
        function (node) { node.remove(); }
      );
      var items = (res.items || []).map(adaptCard);
      if (!items.length && page === 1) {
        grid.appendChild(el('div', 'card-sub', 'В этой папке пусто'));
      } else {
        items.forEach(remember);
        items.forEach(function (t) { grid.appendChild(posterCard(t)); });
      }
      bm.page = page;
      bm.hasMore = !!res.has_more;
      var sub = document.querySelector('#bm-sub');
      if (sub) sub.textContent = '';
      buildBrowseRows('bookmarks');
      if (!FOCUS.bookmarks || FOCUS.bookmarks.r >= ROWS.bookmarks.length) FOCUS.bookmarks = { r: 1, c: 0 };
      markNavCurrent();
      applyFocus();
    })
    .catch(function (e) {
      if (bm !== bmState || folder !== state.bookmarkFolder) return;
      bm.loading = false;
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Ошибка: ' + e.message);
    });
}

function openBookmarks() {
  switchScreen('bookmarks');
  /* список папок перечитываем всегда: счётчики меняются тумблером на
     карточке, новые папки создаются на сайте. Сетки тайтлов при этом не
     трогаем — вкладки обновляются поверх уже загруженного контента */
  api('/bookmarks')
    .then(function (res) {
      var folders = res.folders || [];
      var prev = state.bookmarkFolder;
      state.bookmarkFolders = folders;
      if (!folders.length) {
        state.bookmarkFolder = null;
        SECTION_RENDERED.bookmarks = true;
        renderBookmarks();
        return;
      }
      var stillThere = false;
      folders.forEach(function (f) { if (f.id === prev) stillThere = true; });
      state.bookmarkFolder = stillThere ? prev : folders[0].id;
      if (SECTION_RENDERED.bookmarks && stillThere) {
        updateBookmarkTabs();
        markNavCurrent();
        applyFocus();
        return;
      }
      SECTION_RENDERED.bookmarks = true;
      renderBookmarks();
      FOCUS.bookmarks = { r: 1, c: 0 };
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      /* как в каталоге: инлайн-ошибка с кнопкой повтора, а не один тост —
         иначе после сбоя остаётся пустой экран */
      var c = $('#bookmarks-content');
      c.innerHTML = '';
      c.appendChild(el('div', 'page-head',
        '<h1>Закладки</h1><div class="sub">Не удалось загрузить: ' + esc(e.message) + '</div>'));
      var retry = el('button', 'btn primary focusable', 'Повторить');
      retry.dataset.act = 'retry-bookmarks';
      var wrap = el('div', 'retry-wrap');
      wrap.appendChild(retry);
      c.appendChild(wrap);
      ROWS.bookmarks = [topRow(), [retry]];
      FOCUS.bookmarks = { r: 1, c: 0 };
      markNavCurrent();
      applyFocus();
    });
}

/* перерисовка вкладок папок поверх уже загруженной сетки: свежие счётчики
   и папки, созданные на сайте; фокус остаётся на прежнем элементе */
function updateBookmarkTabs() {
  var c = $('#bookmarks-content');
  var old = c.querySelector('.tabs');
  if (!old) return;
  var tabs = el('div', 'tabs');
  state.bookmarkFolders.forEach(function (f) {
    var tab = el('div', 'tab focusable' + (f.id === state.bookmarkFolder ? ' active' : ''));
    tab.innerHTML = esc(f.title) + '<span class="tab-count">' + (f.count != null ? f.count : 0) + '</span>';
    tab.dataset.folder = f.id;
    tabs.appendChild(tab);
  });
  c.replaceChild(tabs, old);
  rebuildRows('bookmarks', true);
}

function bookmarkTab(tab) {
  state.bookmarkFolder = +tab.dataset.folder;
  Array.prototype.forEach.call(
    document.querySelectorAll('#bookmarks-content .tab'),
    function (t) { t.classList.toggle('active', t === tab); }
  );
  var grid = $('#bookmarks-content .grid');
  if (grid) {
    grid.innerHTML = '';
    for (var bi = 0; bi < 5; bi++) grid.appendChild(el('div', 'skel skel-card'));
  }
  bmState = { folder: state.bookmarkFolder, page: 0, hasMore: false, loading: false };
  loadBookmarksPage();
}

/* -------------------------------- История -------------------------------- */

var historyToken = 0;
var historyTab = 'all';
var historyItems = [];
var HISTORY_TABS = [['all', 'Все'], ['movie', 'Фильмы'], ['serial', 'Сериалы']];

/* пагинация ленты истории: при открытии грузим первую страницу, остальные
   подтягиваются, когда фокус подходит к нижним строкам (как в сетках
   раздела/закладок/поиска) */
var historyState = { nextPage: 1, hasMore: true, loading: false, seen: {} };

/* Единая лента без деления на «продолжить»/«просмотренное»: бэкенд отдаёт
   одну карточку на тайтл (серии схлопнуты в «Сезон · Серию» самого свежего
   просмотра), уже отсортированную по свежести. Порядок на клиенте не
   трогаем — пересортировка давала «прыгающие» записи. */
function historyCard(t) {
  var c = posterCard(t);
  var sub = c.querySelector('.card-sub');
  var parts = [];
  /* isSerial, а не type === 'serial': docuserial/tvshow тоже с сезонами */
  if (isSerial(t) && t.media && t.media.season != null) {
    parts.push('Сезон ' + t.media.season + ' · Серия ' + t.media.number);
  } else if (t.year) {
    parts.push(String(t.year));
  }
  var rel = fmtRel(t.watchedAt);
  if (rel) parts.push(rel);
  sub.textContent = parts.join(' · ');
  if (t.progressPct > 0 && t.progressPct < 100) {
    c.querySelector('.poster-art').appendChild(
      el('div', 'poster-progress', '<i style="width:' + t.progressPct + '%"></i>')
    );
  }
  return c;
}

function historyFiltered() {
  if (historyTab === 'all') return historyItems;
  if (historyTab === 'serial') return historyItems.filter(isSerial);
  return historyItems.filter(function (t) { return !isSerial(t); });
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
    if (historyTab === 'serial' && !isSerial(t)) return;
    if (historyTab === 'movie' && isSerial(t)) return;
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
    body.appendChild(emptyState('history',
      historyItems.length ? 'В этой вкладке пусто' : 'На этом устройстве пока пусто',
      historyItems.length
        ? 'Переключитесь на другую вкладку'
        : 'История собирается отдельно на каждом устройстве'));
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
  c.appendChild(el('div', 'page-head', '<h1>История</h1><div class="sub">Начатое и просмотренное на этом устройстве</div>'));

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

  historyItems = [];
  historyState = { nextPage: 1, hasMore: true, loading: false, seen: {} };
  loadHistoryPage(token, 1);
}

/* Одна страница ленты истории: дорисовываем инкрементально, чтобы экран был
   живым сразу; сбой страницы не блокирует навигацию по уже загруженному */
function loadHistoryPage(token, page) {
  if (token == null) token = historyToken;
  if (historyState.loading || !historyState.hasMore) return;
  historyState.loading = true;
  api('/history?page=' + page)
    .then(function (res) {
      if (token !== historyToken) return;
      historyState.loading = false;
      historyState.nextPage = page + 1;
      historyState.hasMore = !!res.has_more;
      var fresh = [];
      (res.items || []).forEach(function (raw) {
        var t = adaptCard(raw);
        if (!t.id || historyState.seen[t.id]) return;
        historyState.seen[t.id] = 1;
        remember(t);
        historyItems.push(t);
        fresh.push(t);
      });
      appendHistoryCards(fresh);
      /* первая страница пуста (тайтлы сняты upstream), но дальше ещё есть —
         идём дальше; экран пока пустой */
      if (!historyItems.length && historyState.hasMore) {
        loadHistoryPage(token, page + 1);
        return;
      }
      if (historyItems.length) {
        rebuildRows('history', page > 1);
      } else if (!historyState.hasMore) {
        renderHistoryBody(true);
      }
    })
    .catch(function (e) {
      if (token !== historyToken) return;
      historyState.loading = false;
      historyState.hasMore = false; /* оборванную ленту дальше не дёргаем */
      if (e && e.code === 'not_registered') { showRegister(); return; }
      if (historyItems.length) {
        toast('Не удалось догрузить историю целиком');
      } else {
        var c = $('#history-content');
        c.appendChild(el('div', 'empty-state',
          '<div class="es-title">Ошибка загрузки</div>' +
          '<div class="es-sub">' + esc(e.message) + '</div>'));
        rebuildRows('history', false);
      }
    });
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
  /* HEVC — не настройка: флаг на KinoPub выравнивается автоматически под
     реальную поддержку браузера при каждом воспроизведении, ручной тумблер
     всё равно перезаписывался */
  c.appendChild(rows);

  var acts = el('div', 'set-rows set-acts');
  var reboot = el('div', 'set-row focusable');
  reboot.dataset.act = 'reboot';
  reboot.innerHTML = '<div>' + esc('Перезагрузка приложения') +
    '<div class="row-sub">' + esc('Перезапуск и очистка кэша') + '</div></div>' +
    '<div class="set-act-ico">↻</div>';
  acts.appendChild(reboot);
  var clearHist = el('div', 'set-row focusable');
  clearHist.dataset.act = 'clear-history';
  clearHist.innerHTML = '<div>' + esc('Очистка истории просмотра') +
    '<div class="row-sub">' + esc('Удаляет историю только на этом устройстве') + '</div></div>' +
    '<div class="set-act-ico"><svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg></div>';
  acts.appendChild(clearHist);
  c.appendChild(acts);

  /* служебная строка: версия и идентификатор устройства для диагностики */
  var ver = (state.settings && state.settings.version) || '';
  var dev = String(window.KPTV.deviceId || '');
  c.appendChild(el('div', 'set-version',
    'KPTV' + (ver ? ' v' + esc(ver) : '') +
    (dev ? ' · устройство ' + esc(dev.slice(0, 8)) : '')));

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

/* Общий сейв настроек: переключатели шлют инвертированное значение,
   poster_size — следующее по циклу. Профиль сохраняем из прошлого ответа,
   POST отдаёт только настройки (иначе блок подписки пропадает после каждого
   переключения) */
function saveSetting(key, value, focusRow) {
  var patch = {};
  patch[key] = value;
  api('/settings', { method: 'POST', body: patch })
    .then(function (res) {
      state.settings = {
        settings: res.settings,
        account: state.settings && state.settings.account,
        version: state.settings && state.settings.version,
      };
      renderSettings();
      FOCUS.settings = { r: Math.min(focusRow, ROWS.settings.length - 1), c: 0 };
      applyFocus();
      toast('Сохранено');
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Ошибка: ' + e.message);
    });
}

function toggleSetting(row) {
  var key = row.dataset.set;
  var s = (state.settings && state.settings.settings) || {};
  saveSetting(key, !s[key], FOCUS.settings.r);
}

/* Очистка истории просмотра. Бэкенд стирает только локальные строки
   устройства (device_history); общая история аккаунта KinoPub не трогается.
   Экран истории перечитывается при каждом открытии — сбрасывать его не нужно */
function clearWatchHistory() {
  api('/history/clear', { method: 'POST' })
    .then(function () {
      toast('История просмотра на этом устройстве очищена');
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Ошибка: ' + e.message);
    });
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

/* Папки создаются только в аккаунте KinoPub (на сайте) — здесь лишь
   переключаем принадлежность тайтла уже существующим папкам */
function openBookmarkFolders() {
  state.modal = 'bookmarks';
  state.modalIdx = 0;
  renderModal();
}

function renderModal() {
  var box = $('#modal-box');
  box.className = '';

  var t = state.title;
  var folders = t.folders || [];
  var body;
  if (!folders.length) {
    body = '<div class="modal-empty">Папок закладок пока нет.<br>' +
      'Создайте папку в своём аккаунте на kino.pub — она появится здесь.</div>';
  } else {
    body = folders.map(function (f, i) {
      var inside = t.bookmarks.indexOf(f.id) >= 0;
      return '<div class="modal-item' + (i === state.modalIdx ? ' cur' : '') + '" data-i="' + i + '">' +
        '<span class="mi-check">' + (inside ? '✓' : '') + '</span>' +
        '<span class="mi-name">' + esc(f.title) + '</span>' +
        '<span class="mi-count">' + (f.count != null ? f.count : '') + '</span></div>';
    }).join('');
  }
  box.innerHTML = '<div class="popup-title">Закладки</div>' + body;
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
      /* та же папка в списке раздела «Закладки» — там свой объект со
         своим счётчиком, синхронизируем оба */
      state.bookmarkFolders.forEach(function (bf) {
        if (bf.id === f.id && bf.count != null) {
          bf.count += (nowIn ? 1 : 0) - (wasIn ? 1 : 0);
        }
      });
      renderModal();
      syncBookmarkButton();
    })
    .catch(function (e) {
      if (e && e.code === 'not_registered') { showRegister(); return; }
      toast('Ошибка: ' + e.message);
    });
}

function activate() {
  var rows = ROWS[state.screen], f = FOCUS[state.screen];
  var elm = rows[f.r] && rows[f.r][f.c];
  if (!elm) return;

  if (BROWSE_SCREENS.indexOf(state.screen) >= 0) {
    if (elm.dataset.nav) return navAction(elm.dataset.nav);
  }

  if (state.screen === 'home') {
    if (elm.dataset.act === 'retry-home') return loadHome();
    if (elm.dataset.act === 'watch') return openPlayer(Number(elm.closest('.hero').dataset.id || FEATURED_ID));
    if (elm.dataset.act === 'more') return openDetail(FEATURED_ID);
    if (elm.dataset.kind === 'watch') return playResume(Number(elm.dataset.id));
    if (elm.dataset.kind === 'title') return openDetail(Number(elm.dataset.id));
  }

  if (state.screen === 'catalog' || state.screen === 'section' ||
      state.screen === 'collections' || state.screen === 'search' ||
      state.screen === 'bookmarks' || state.screen === 'history') {
    if (elm.dataset.act === 'retry-catalog') {
      delete SECTION_RENDERED['catalog:' + state.catalogType];
      return openCatalog(state.catalogType);
    }
    if (elm.dataset.act === 'retry-bookmarks') return openBookmarks();
    if (elm.dataset.act === 'retry-section') return loadSectionPage();
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
    if (elm.dataset.kind === 'watch') return playResume(Number(elm.dataset.id));
    if (elm.dataset.kind === 'title') return openDetail(Number(elm.dataset.id));
  }

  if (state.screen === 'settings') {
    if (elm.dataset.act === 'reboot') return reloadApp();
    if (elm.dataset.act === 'clear-history') return clearWatchHistory();
    if (elm.dataset.set) return toggleSetting(elm);
  }

  if (state.screen === 'detail') {
    var a = elm.dataset.act;
    /* при живой точке возобновления «Смотреть» — старт с начала (resume
       отдельной кнопкой), иначе обе кнопки делали бы одно и то же */
    if (a === 'watch') return openPlayer(state.title.id, null, null, hasResume(state.title));
    if (a === 'resume') return playResume(state.title.id);
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
  if (state.playerError) {
    /* оверлей ошибки: подтверждение или назад — единственное действие */
    if (k === 'Enter' || k === 'Backspace') goBack();
    e.preventDefault();
    return;
  }
  if (state.autoNext) {
    /* отсчёт автоперехода: стрелки — между кнопками, OK — выбрать,
       Backspace — отменить и остаться в плеере */
    var an = state.autoNext;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      an.cur = an.cur ? 0 : 1;
      renderAutoNext();
    } else if (k === 'Enter') {
      an.cur === 0 ? autoNextRun() : autoNextStop();
    } else if (k === 'Backspace') {
      autoNextStop();
    } else return;
    e.preventDefault();
    showOverlay();
    return;
  }
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
  if (!vis) {
    /* панель скрыта: транспортные клавиши работают сразу, остальные —
       только показывают панель (меньше «холостых» нажатий) */
    if (k === 'ArrowLeft') activateControl('rew');
    else if (k === 'ArrowRight') activateControl('fwd');
    else if (k === ' ' || k === 'Pause' || k === 'Play') activateControl('play');
    else if (k === 'Rewind') activateControl('rew');
    else if (k === 'FastForward') activateControl('fwd');
    showOverlay();
    e.preventDefault();
    return;
  }
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
  else if (k === 'Enter') { if (f.r === 0) togglePlay(); else activateControl(ROWS.player[1][f.c].dataset.c); }
  else if (k === ' ' || k === 'Pause' || k === 'Play') { activateControl('play'); }
  else if (k === 'Rewind') { activateControl('rew'); }
  else if (k === 'FastForward') { activateControl('fwd'); }
  else return;
  showOverlay();
  e.preventDefault();
}

document.addEventListener('keydown', function (e) {
  var k = normKey(e);
  if (state.modal) {
    var n = state.title && state.title.folders ? state.title.folders.length : 0;
    if (k === 'ArrowUp') { state.modalIdx = Math.max(0, state.modalIdx - 1); renderModal(); }
    else if (k === 'ArrowDown') { state.modalIdx = Math.min(Math.max(0, n - 1), state.modalIdx + 1); renderModal(); }
    else if (k === 'Enter') toggleBookmarkFolder(state.modalIdx);
    else if (k === 'Backspace') closeModal();
    else return;
    e.preventDefault();
    return;
  }
  if (state.screen === 'player') return playerKey(k, e);
  /* повторы клавиши, которой вошли в меню, гасим — фокус остаётся на пункте
     текущего раздела, а не уезжает к первому пункту (см. enterMenu) */
  if (e.repeat && menuRepeatGuard) { e.preventDefault(); return; }
  menuRepeatGuard = false;
  if (k === 'ArrowLeft') move(-1, 0);
  else if (k === 'ArrowRight') move(1, 0);
  else if (k === 'ArrowUp') move(0, -1);
  else if (k === 'ArrowDown') move(0, 1);
  else if (k === 'Enter') activate();
  else if (k === 'Backspace') {
    /* на экране поиска Backspace стирает символы; «назад» — только когда
       строка пустая (на остальных экранах — как раньше) */
    if (state.screen === 'search' && state.query.length) {
      state.query = state.query.slice(0, -1);
      updateQueryBar();
      scheduleLiveSearch();
    } else goBack();
  }
  else if (state.screen === 'search' && k.length === 1 &&
           !e.ctrlKey && !e.altKey && !e.metaKey) {
    /* печать с физической клавиатуры: символ сразу в строку запроса */
    state.query += k;
    updateQueryBar();
    scheduleLiveSearch();
  }
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
    setBuffering(false);
    updateControlLabels();
    reportProgress();
  });
  video.addEventListener('play', function () {
    state.playing = true;
    updateControlLabels();
  });
  video.addEventListener('playing', function () { setBuffering(false); });
  video.addEventListener('canplay', function () { setBuffering(false); });
  video.addEventListener('seeked', function () { setBuffering(false); });
  video.addEventListener('waiting', function () {
    if (state.screen === 'player' && state.playing) setBuffering(true);
  });
  video.addEventListener('seeking', function () {
    if (state.screen === 'player') setBuffering(true);
  });
  video.addEventListener('stalled', function () {
    if (state.screen === 'player' && state.playing) setBuffering(true);
  });
  video.addEventListener('ended', function () {
    state.playing = false;
    setBuffering(false);
    updateControlLabels();
    reportProgress();
    autoNextStart();
  });
  video.addEventListener('error', function () {
    setBuffering(false);
    /* hls.js жив — сработает его лестница восстановления (startLoad /
       recoverMediaError / переход на нативный плеер), не мешаем. Оверлей
       показываем только когда дальше некуда: нативный плеер и без hls.js */
    if (state.screen === 'player' && !state.hls) showPlayerError();
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
    if (state.playerError) {
      if (e.target.closest('[data-act="player-back"]')) goBack();
      return;
    }
    if (state.autoNext) {
      var an = e.target.closest('[data-an]');
      if (an) { an.dataset.an === 'play' ? autoNextRun() : autoNextStop(); }
      return;
    }
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
  $('#register-expires').classList.add('hidden');
  $('#register-hint').textContent = 'Ожидаем подключения…';
  $('#register-qr').classList.add('hidden');
  $('#register-retry').classList.add('hidden');

  api('/auth/code', { method: 'POST' })
    .then(function (data) {
      if (token !== registerToken) return;
      $('#register-code').textContent = data.user_code;
      /* срок жизни кода от KinoPub: без подписи пользователь не понимает,
         почему «вчерашний» код не подошёл */
      var exp = $('#register-expires');
      if (exp) {
        if (data.expires_in) {
          var mins = Math.round(data.expires_in / 60);
          exp.textContent = mins >= 1
            ? 'Код действует ' + mins + ' мин.'
            : 'Код действует ' + data.expires_in + ' сек.';
          exp.classList.remove('hidden');
        } else {
          exp.classList.add('hidden');
        }
      }
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
            if (e.code === 'no_code') {
              /* строку устройства собрал GC (неактивированные живут сутки) —
                 код на kino.pub уже не привяжется, начинаем заново */
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
  if (!SECTION_RENDERED.home) renderHomeSkeleton();
  loadHome();
}

buildPlayer();
fit();
boot();
