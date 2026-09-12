/* =========================================================
   秋田プレミアムチケット 加盟店マップ
   data/shops.json のレコード構造（配列で持たせて軽量化）
     0 name  1 cityIdx  2 addr  3 tel  4 url
     5 [sectorIdx...]  6 ticketBits(1=紙 2=電子)  7 lat  8 lng  9 precision
   ========================================================= */
'use strict';

const F = { NAME: 0, CITY: 1, ADDR: 2, TEL: 3, URL: 4, SEC: 5, TK: 6, LAT: 7, LNG: 8, PREC: 9 };

const AKITA = { center: [39.72, 140.35], zoom: 9 };
// 加盟店の4割が秋田市にあるため、起動時の表示は少し秋田市寄りにする
const CITY_CENTER = [39.7186, 140.1024];
const CITY_BIAS = 0.4;
const ICON_ZOOM = 16;   // このズーム以上では店ごとのアイコンを出す

const BASEMAPS = [
  {
    id: 'osm', label: '地図', max: 19,
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
  {
    id: 'photo', label: '航空写真', max: 18,
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>（国土地理院）',
  },
];

const PAGE = 40;           // 一覧の追加読み込み単位
const store = {
  q: '', cities: new Set(), sectors: new Set(), ticket: 0,
  me: null, sel: -1, shown: PAGE,
};

let DATA = null;
let map, cluster, tileLayer, meLayer;
let markers = [];          // shop index -> L.Marker
const groups = new Map();  // 代表の shop index -> 同じ場所の shop index 一覧
let hits = [];             // 絞り込み条件に合う店（shop index の配列）
let inView = [];           // そのうち、いま地図に映っている分（一覧に出すのはこれ）
let baseIdx = 0;

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------------------------------------------------
   小さなユーティリティ
   --------------------------------------------------------- */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 検索用の正規化：全角英数を半角に、カタカナをひらがなに、小文字化
function norm(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[ー－‐―−]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function haversine(a, b, c, d) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtDist = (km) => km < 1 ? `${Math.round(km * 1000)}m` : km < 10 ? `${km.toFixed(1)}km` : `${Math.round(km)}km`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------------------------------------------------
   起動
   --------------------------------------------------------- */

fetch('data/shops.json')
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((json) => { DATA = json; boot(); })
  .catch((e) => {
    $('#list').innerHTML = `<div class="empty"><b>データを読み込めませんでした</b>${esc(e.message)}<br>
      ページを再読み込みしてください。</div>`;
    $('#sheet').dataset.snap = 'half';
  });

function boot() {
  buildMap();
  buildMarkers();
  buildFilterUI();
  bindUI();
  readHash();
  apply({ fit: true });
  // 共有された絞り込みリンクで開いた時は、その結果の位置を尊重する
  if (!location.hash) biasToCity();
}

// 県全体が収まったまま、中心だけ秋田市の方へ寄せる
function biasToCity() {
  const c = map.getCenter();
  map.setView([
    c.lat + (CITY_CENTER[0] - c.lat) * CITY_BIAS,
    c.lng + (CITY_CENTER[1] - c.lng) * CITY_BIAS,
  ], map.getZoom(), { animate: false });
}

/* ---------------------------------------------------------
   地図
   --------------------------------------------------------- */

function buildMap() {
  map = L.map('map', {
    center: AKITA.center,
    zoom: AKITA.zoom,
    zoomControl: false,
    attributionControl: true,
    // 既定の整数ズームだと県全体を映したときに余白が多すぎるため、
    // 0.25 刻みで中間のズームも使えるようにする
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    preferCanvas: true,
    tap: false,
  });

  baseIdx = Math.max(0, BASEMAPS.findIndex((b) => b.id === localStorage.getItem('apt-base')));
  if (baseIdx < 0) baseIdx = 0;
  setBasemap(baseIdx);

  cluster = L.markerClusterGroup({
    maxClusterRadius: (z) => (z < 11 ? 70 : z < 13 ? 50 : z < 15 ? 34 : 22),
    disableClusteringAtZoom: ICON_ZOOM,   // これ以上ズームすると店ごとのアイコンになる
    spiderfyOnMaxZoom: false,
    showCoverageOnHover: false,
    chunkedLoading: true,
    chunkInterval: 120,
    iconCreateFunction(c) {
      const n = c.getChildCount();
      const cls = n < 20 ? 'small' : n < 150 ? 'medium' : 'large';
      return L.divIcon({
        html: `<div><span>${n}</span></div>`,
        className: `marker-cluster marker-cluster-${cls}`,
        iconSize: null,
      });
    },
  }).addTo(map);

  map.on('click', () => closeDetail());

  // 地図を動かし終えたら、映っている範囲で一覧を作り直す
  let viewTimer;
  map.on('moveend zoomend', () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (DATA) refreshView(); }, 140);
  });
}

function setBasemap(i) {
  const b = BASEMAPS[i];
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(b.url, {
    maxZoom: 19, maxNativeZoom: b.max, attribution: b.attr, detectRetina: false,
  }).addTo(map);
  localStorage.setItem('apt-base', b.id);
}

function pinIcon(i, count) {
  const s = DATA.shops[i];
  const sec = DATA.sectors[s[F.SEC][0]] || DATA.sectors[DATA.sectors.length - 1];
  return L.divIcon({
    className: '',
    html: `<div class="pin" style="background:${sec.c}"><span>${sec.e}</span>` +
          (count > 1 ? `<i class="pinbadge">${count}</i>` : '') + '</div>',
    iconSize: null,
  });
}

function buildMarkers() {
  markers = DATA.shops.map((s, i) => {
    const m = L.marker([s[F.LAT], s[F.LNG]], { icon: pinIcon(i, 1), title: s[F.NAME], keyboard: false });
    m.on('click', () => {
      const g = groups.get(i);
      if (g && g.length > 1) openGroup(i);
      else openDetail(i, false);
    });
    return m;
  });
}

/* ---------------------------------------------------------
   絞り込み
   --------------------------------------------------------- */

function apply(opts = {}) {
  // 先に空白で区切ってから正規化する（norm は空白を除去するため順序が重要）
  const terms = store.q.split(/[\s　]+/).map(norm).filter(Boolean);
  const out = [];

  for (let i = 0; i < DATA.shops.length; i++) {
    const s = DATA.shops[i];
    if (store.ticket && !(s[F.TK] & store.ticket)) continue;
    if (store.cities.size && !store.cities.has(s[F.CITY])) continue;
    if (store.sectors.size && !s[F.SEC].some((x) => store.sectors.has(x))) continue;
    if (terms.length) {
      const hay = s._h || (s._h = norm(
        s[F.NAME] + DATA.cities[s[F.CITY]] + s[F.ADDR] +
        s[F.SEC].map((x) => DATA.sectors[x].n).join('')));
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    out.push(i);
  }

  hits = out;

  // 同じ番地の店舗は座標が一致するので、地図上は代表の1本にまとめて件数を出す
  groups.clear();
  const rep = new Map();
  for (const i of out) {
    const s = DATA.shops[i];
    const k = s[F.LAT] + ',' + s[F.LNG];
    if (rep.has(k)) {
      groups.get(rep.get(k)).push(i);
    } else {
      rep.set(k, i);
      groups.set(i, [i]);
    }
  }
  const reps = [...rep.values()];
  for (const i of reps) markers[i].setIcon(pinIcon(i, groups.get(i).length));

  cluster.clearLayers();
  cluster.addLayers(reps.map((i) => markers[i]));

  renderChips();
  syncFilterUI();
  writeHash();

  if (opts.fit && out.length) fitToHits();
  refreshView();
}

// いま地図に映っている店を、画面の中心に近い順に並べて一覧に出す
function refreshView() {
  const b = map.getBounds();
  const c = map.getCenter();
  const d = new Map();
  inView = [];
  for (const i of hits) {
    const s = DATA.shops[i];
    if (!b.contains([s[F.LAT], s[F.LNG]])) continue;
    d.set(i, haversine(c.lat, c.lng, s[F.LAT], s[F.LNG]));
    inView.push(i);
  }
  inView.sort((x, y) => d.get(x) - d.get(y));

  store.shown = PAGE;
  $('#list').scrollTop = 0;
  renderCount();
  renderList();
}

function fitToHits() {
  if (!hits.length) return;
  const b = L.latLngBounds(hits.map((i) => [DATA.shops[i][F.LAT], DATA.shops[i][F.LNG]]));
  const wide = innerWidth > 860;
  map.fitBounds(b, {
    // 検索バーとシートに隠れない範囲に収める
    paddingTopLeft: [40, wide ? 76 : 74],
    paddingBottomRight: [40, wide ? 40 : 150],
    maxZoom: 15,
    animate: false,
  });
}

function activeCount() {
  return store.cities.size + store.sectors.size + (store.ticket ? 1 : 0);
}

/* ---------------------------------------------------------
   描画：件数・条件チップ・一覧
   --------------------------------------------------------- */

function renderCount() {
  $('#hitCount').textContent = inView.length.toLocaleString('ja-JP');

  // 地図の外にも該当店があるときは、全件に戻すボタンを出す
  const rest = hits.length - inView.length;
  const all = $('#btnAll');
  all.hidden = rest <= 0;
  all.textContent = `全${hits.length.toLocaleString('ja-JP')}件を表示`;

  const n = activeCount();
  $('#filterCount').hidden = !n;
  $('#filterCount').textContent = n;
  $('#filterBtn').classList.toggle('is-on', !!n);
  $('#qclear').hidden = !store.q && !n;
  $('#fApply').textContent = `${hits.length.toLocaleString('ja-JP')}件を見る`;
}

function renderChips() {
  const bar = $('#chipbar');
  const tags = [];
  if (store.ticket) tags.push({ k: 'ticket', v: store.ticket, t: store.ticket === 2 ? '電子チケット' : '紙チケット' });
  store.sectors.forEach((i) => tags.push({ k: 'sector', v: i, t: DATA.sectors[i].s }));
  store.cities.forEach((i) => tags.push({ k: 'city', v: i, t: DATA.cities[i] }));

  bar.hidden = !tags.length;
  bar.innerHTML = tags.map((g) => `<span class="tag">${esc(g.t)}
    <button type="button" data-k="${g.k}" data-v="${g.v}" aria-label="${esc(g.t)}の条件を外す">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`).join('');
}

function renderList() {
  const list = $('#list');

  if (!inView.length) {
    list.innerHTML = hits.length
      ? `<div class="empty"><b>この範囲にお店がありません</b>
           地図を動かすかズームアウトしてください。<br>
           <button class="more" type="button" id="btnAllEmpty">全${hits.length.toLocaleString('ja-JP')}件を表示</button></div>`
      : `<div class="empty"><b>該当するお店がありません</b>
           キーワードを短くするか、絞り込み条件を減らしてみてください。</div>`;
    return;
  }

  const me = store.me;
  const slice = inView.slice(0, store.shown);

  list.innerHTML = slice.map((i) => {
    const s = DATA.shops[i];
    const sec = DATA.sectors[s[F.SEC][0]];
    const dist = me
      ? (s[F.PREC] ? '約' : '') + fmtDist(haversine(me[0], me[1], s[F.LAT], s[F.LNG]))
      : '';
    return `<button class="row${i === store.sel ? ' is-sel' : ''}" data-i="${i}" type="button">
      <span class="ic" style="background:${sec.c}22;color:${sec.c}">${sec.e}</span>
      <span class="nm">${esc(s[F.NAME])}</span>
      ${dist ? `<span class="dist">${dist}</span>` : '<span></span>'}
      <span class="meta">
        ${s[F.TK] & 2 ? '<span class="tk e">電子</span>' : ''}
        ${s[F.TK] & 1 ? '<span class="tk p">紙</span>' : ''}
        <span class="sec">${esc(s[F.SEC].map((x) => DATA.sectors[x].s).join('・'))}</span>
        <span class="addr">${esc(s[F.ADDR])}${s[F.PREC] === 2 ? '（詳しい住所は非公開）' : ''}</span>
      </span>
    </button>`;
  }).join('');

  const rest = inView.length - store.shown;
  if (rest > 0) {
    list.insertAdjacentHTML('beforeend',
      `<button class="more" type="button" id="btnMore">さらに表示（残り ${rest.toLocaleString('ja-JP')}件）</button>`);
  }
}

/* ---------------------------------------------------------
   詳細カード
   --------------------------------------------------------- */

function openGroup(repIdx) {
  const list = groups.get(repIdx) || [repIdx];
  const s0 = DATA.shops[repIdx];
  store.sel = repIdx;

  // 業種（1つ目）ごとにまとめる。並びは公式の業種区分の順。
  const bySec = new Map();
  for (const i of list) {
    const k = DATA.shops[i][F.SEC][0];
    (bySec.get(k) || bySec.set(k, []).get(k)).push(i);
  }
  const order = [...bySec.keys()].sort((a, b) => a - b);

  // 住所が全部同じならそれを、違えば共通する部分までを見出しに出す
  const addrs = [...new Set(list.map((i) => DATA.shops[i][F.ADDR]))];
  let head;
  if (addrs.length === 1) {
    head = addrs[0];
  } else {
    const common = addrs.reduce((a, b) => {
      let n = 0;
      while (n < a.length && n < b.length && a[n] === b[n]) n++;
      return a.slice(0, n);
    });
    // 途中で切れた建物名などを落とす
    const trimmed = common.replace(/[^0-9０-９丁目番地号町字]+$/, '');
    head = (trimmed.length > 5 ? trimmed : DATA.cities[s0[F.CITY]]) + ' 付近';
  }

  $('#detail').innerHTML = `
    <div class="d-head">
      <span class="d-ic multi">${list.length}</span>
      <div>
        <div class="d-nm">この場所の${list.length}店舗</div>
        <div class="d-sec">${esc(head)}</div>
      </div>
      <button class="d-x" type="button" id="dClose" aria-label="閉じる">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="d-body g-body">
      ${order.map((k) => {
        const sec = DATA.sectors[k];
        const mem = bySec.get(k);
        return `<div class="g-sec">
            <span class="g-ic" style="background:${sec.c}22;color:${sec.c}">${sec.e}</span>
            <span class="g-nm">${esc(sec.n)}</span>
            <span class="g-x">×${mem.length}</span>
          </div>
          ${mem.map((i) => `<button class="g-row" type="button" data-i="${i}">
            <span>${esc(DATA.shops[i][F.NAME])}</span>
            <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
          </button>`).join('')}`;
      }).join('')}
    </div>`;

  $('#detail').hidden = false;
  $('#detail').dataset.group = repIdx;
  $('#dClose').onclick = () => closeDetail();
  highlightSelection();
  map.setView([s0[F.LAT], s0[F.LNG]], Math.max(map.getZoom(), ICON_ZOOM), { animate: true });
}

function openDetail(i, pan = true, back = null) {
  store.sel = i;
  const s = DATA.shops[i];
  const sec = DATA.sectors[s[F.SEC][0]];
  const d = $('#detail');

  const gq = encodeURIComponent(`${s[F.NAME]} 秋田県${s[F.ADDR]}`);
  const note = [
    '※ 地図上の位置は参考程度にご覧ください',
    '※ 番地までの位置情報が無いため、地図上は町名のおおよその場所です',
    '※ 詳しい住所が公開されていないため、地図上は市町村のおおよその中心です',
  ][s[F.PREC]];

  d.innerHTML = `
    <div class="d-head">
      <span class="d-ic" style="background:${sec.c}22;color:${sec.c}">${sec.e}</span>
      <div>
        <div class="d-nm">${esc(s[F.NAME])}</div>
        <div class="d-sec">${esc(s[F.SEC].map((x) => DATA.sectors[x].n).join(' / '))}</div>
      </div>
      <button class="d-x" type="button" id="dClose" aria-label="閉じる">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    ${back ? `<button class="d-back" type="button" id="dBack">
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>この場所の一覧に戻る</button>` : ''}
    <div class="d-body">
      <div class="d-tk">
        ${s[F.TK] & 2 ? '<span class="tk e">電子チケット</span>' : ''}
        ${s[F.TK] & 1 ? '<span class="tk p">紙チケット</span>' : ''}
      </div>
      <div class="d-line">
        <svg viewBox="0 0 24 24"><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>
        <div>${esc(s[F.ADDR])}
          ${note ? `<span class="sub">${note}</span>` : ''}</div>
      </div>
      ${s[F.TEL] ? `<div class="d-line">
        <svg viewBox="0 0 24 24"><path d="M5 3h3.5l1.7 4.3-2.1 1.6a12.5 12.5 0 006 6l1.6-2.1L20 14.5V18a2 2 0 01-2.2 2A16.5 16.5 0 014 6.2 2 2 0 016 4z"/></svg>
        <div><a href="tel:${esc(s[F.TEL].replace(/[^0-9+]/g, ''))}">${esc(s[F.TEL])}</a></div>
      </div>` : ''}
      ${s[F.URL] ? `<div class="d-line">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a15 15 0 010 17 15 15 0 010-17z"/></svg>
        <div><a href="${esc(s[F.URL])}" target="_blank" rel="noopener">公式サイト</a></div>
      </div>` : ''}
    </div>
    <div class="d-foot one">
      <a class="btn solid" href="https://www.google.com/maps/search/?api=1&query=${gq}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24"><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/></svg>経路を調べる</a>
    </div>`;

  d.hidden = false;
  d.dataset.group = '';
  $('#dClose').onclick = () => closeDetail();
  if (back !== null) $('#dBack').onclick = () => openGroup(back);

  highlightSelection();
  if (pan) map.setView([s[F.LAT], s[F.LNG]], Math.max(map.getZoom(), 16), { animate: true });
  else cluster.zoomToShowLayer?.(markers[i], () => {});
}

function closeDetail() {
  $('#detail').hidden = true;
  $('#detail').dataset.group = '';
  store.sel = -1;
  highlightSelection();
}

function highlightSelection() {
  $$('.pin.is-sel').forEach((el) => el.classList.remove('is-sel'));
  const m = markers[store.sel];
  const el = m && m._icon && m._icon.querySelector('.pin');
  if (el) el.classList.add('is-sel');
  $$('.row.is-sel').forEach((el) => el.classList.remove('is-sel'));
  const row = $(`.row[data-i="${store.sel}"]`);
  if (row) row.classList.add('is-sel');
}

/* ---------------------------------------------------------
   絞り込みパネル
   --------------------------------------------------------- */

function buildFilterUI() {
  const cityN = new Array(DATA.cities.length).fill(0);
  const secN  = new Array(DATA.sectors.length).fill(0);
  for (const s of DATA.shops) {
    cityN[s[F.CITY]]++;
    for (const x of s[F.SEC]) secN[x]++;
  }

  $('#fTicket').innerHTML = [[1, '紙チケット'], [2, '電子チケット']]
    .map(([v, t]) => `<button class="chip" type="button" data-k="ticket" data-v="${v}" aria-pressed="false">${t}</button>`).join('');

  $('#fSector').innerHTML = DATA.sectors
    .map((s, i) => `<button class="chip" type="button" data-k="sector" data-v="${i}" aria-pressed="false">
      <span class="dot" style="background:${s.c}"></span>${esc(s.s)}<span class="n">${secN[i]}</span></button>`).join('');

  $('#fCity').innerHTML = DATA.cities
    .map((c, i) => `<button class="chip" type="button" data-k="city" data-v="${i}" aria-pressed="false">
      ${esc(c)}<span class="n">${cityN[i]}</span></button>`).join('');
}

function syncFilterUI() {
  $$('#filterPane .chip').forEach((el) => {
    const v = +el.dataset.v;
    const on = el.dataset.k === 'ticket' ? store.ticket === v
             : el.dataset.k === 'sector' ? store.sectors.has(v)
             : store.cities.has(v);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function toggleFilter(k, v) {
  if (k === 'ticket') store.ticket = store.ticket === v ? 0 : v;
  else {
    const set = k === 'sector' ? store.sectors : store.cities;
    set.has(v) ? set.delete(v) : set.add(v);
  }
}

/* ---------------------------------------------------------
   現在地
   --------------------------------------------------------- */

function locate() {
  if (!navigator.geolocation) { toast('この端末では現在地を取得できません'); return; }
  const btn = $('#btnLocate');
  btn.classList.add('is-on');
  toast('現在地を取得しています…');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: la, longitude: lo } = pos.coords;
      store.me = [la, lo];
      if (meLayer) map.removeLayer(meLayer);
      meLayer = L.marker([la, lo], {
        icon: L.divIcon({ className: '', html: '<div class="mepin"></div>', iconSize: null }),
        interactive: false, zIndexOffset: 1000,
      }).addTo(map);

      map.setView([la, lo], 14, { animate: true });
      snap('half');
      if (la < 38.5 || la > 40.6 || lo < 139.4 || lo > 141.1) {
        toast('秋田県外にいるようです。近い順は参考程度にご覧ください');
      }
    },
    (err) => {
      btn.classList.remove('is-on');
      toast(err.code === 1 ? '現在地の利用が許可されていません' : '現在地を取得できませんでした');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
}

/* ---------------------------------------------------------
   シートの開閉（スマホ）
   --------------------------------------------------------- */

const SNAPS = ['peek', 'half', 'full'];

function snap(name) {
  $('#sheet').dataset.snap = name;
  document.body.dataset.snap = name;
  if (name !== 'peek') $('#detail').hidden = true;
}

function sheetHeights() {
  const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek'));
  return { peek, half: innerHeight * 0.52, full: innerHeight - 132 };
}

function nearestSnap(h) {
  const H = sheetHeights();
  return SNAPS.reduce((best, n) => (Math.abs(H[n] - h) < Math.abs(H[best] - h) ? n : best), SNAPS[0]);
}

function bindSheetDrag() {
  const sheet = $('#sheet');
  const list = $('#list');
  let g = null;   // 進行中のジェスチャー

  const FLICK = 0.4;    // px/ms。これより速ければ弾いた扱い
  const SLOP = 6;       // これだけ動いたらドラッグ開始（タップと区別する）
  let swallow = false;  // ドラッグ直後の click を1回だけ握りつぶす

  // スワイプで指を離したあと、ブラウザは最後に触れていた要素に click を出す。
  // そのままだと一覧をスワイプしただけで店舗が開いてしまうので、ここで止める。
  sheet.addEventListener('click', (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  sheet.addEventListener('pointerdown', (e) => {
    if (innerWidth > 860 || g) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const onHandle = !!e.target.closest('.grab, .sheethead, .chipbar');
    const onList = list.contains(e.target);
    if (!onHandle && !onList) return;
    // 全画面で一覧を読んでいる最中は、シートではなく一覧を動かす
    if (onList && sheet.dataset.snap === 'full' && list.scrollTop > 0) return;

    g = {
      id: e.pointerId,
      y0: e.clientY, y: e.clientY, t: performance.now(),
      h0: sheet.getBoundingClientRect().height,
      from: sheet.dataset.snap,
      v: 0, active: false, onList,
      tapTarget: e.target.closest('.grab'),
    };
  });

  addEventListener('pointermove', onMove, { passive: false });
  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    const dy = e.clientY - g.y0;

    if (!g.active) {
      if (Math.abs(dy) < SLOP) return;
      // 一覧から上方向に引いた時、すでに全開なら一覧のスクロールに任せる
      if (g.onList && dy < 0 && g.from === 'full') { g = null; return; }
      g.active = true;
      sheet.classList.add('is-drag');
      document.body.classList.add('is-dragging');
    }

    if (e.cancelable) e.preventDefault();
    const now = performance.now();
    if (now > g.t) g.v = (e.clientY - g.y) / (now - g.t);   // 下向きが正
    g.y = e.clientY;
    g.t = now;

    const H = sheetHeights();
    sheet.style.height = Math.min(H.full, Math.max(H.peek, g.h0 - dy)) + 'px';
  }

  // 全画面で一覧の先頭にいるとき、下方向のスワイプはブラウザのスクロール判定より先に
  // こちらが引き取る（そうしないと pointercancel が飛んでドラッグが中断される）
  let touchY0 = 0;
  list.addEventListener('touchstart', (e) => {
    touchY0 = e.touches[0].clientY;
  }, { passive: true });

  list.addEventListener('touchmove', (e) => {
    if (innerWidth > 860 || !g) return;
    if (sheet.dataset.snap !== 'full' || list.scrollTop > 0) return;
    if (e.touches[0].clientY - touchY0 > 2 && e.cancelable) e.preventDefault();
  }, { passive: false });

  const finish = (e) => {
    if (!g || (e && e.pointerId !== g.id)) return;
    const s = g;
    g = null;
    sheet.classList.remove('is-drag');
    document.body.classList.remove('is-dragging');

    if (!s.active) {
      // 動いていなければタップ。取っ手を叩いた時だけ開閉する。
      if (s.tapTarget) cycleSheet();
      return;
    }

    swallow = true;
    setTimeout(() => { swallow = false; }, 400);

    const h = sheet.getBoundingClientRect().height;
    sheet.style.height = '';
    const i = SNAPS.indexOf(s.from);
    let next;
    if (s.v < -FLICK) next = SNAPS[Math.min(SNAPS.length - 1, i + 1)];   // 上へ弾いた
    else if (s.v > FLICK) next = SNAPS[Math.max(0, i - 1)];              // 下へ弾いた
    else next = nearestSnap(h);
    snap(next);
  };

  addEventListener('pointerup', finish);
  addEventListener('pointercancel', (e) => {
    // ブラウザがスクロールとして引き取った場合。ドラッグ中でなければ黙って取り下げる。
    if (g && !g.active && (!e || e.pointerId === g.id)) { g = null; return; }
    finish(e);
  });
  // 何かの拍子にジェスチャーが宙ぶらりんになっても次の操作を妨げない
  addEventListener('blur', () => { if (g) finish(); });

  $('#grab').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSheet(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
  });
}

function step(d) {
  const i = SNAPS.indexOf($('#sheet').dataset.snap);
  snap(SNAPS[Math.min(SNAPS.length - 1, Math.max(0, i + d))]);
}

function cycleSheet() {
  const cur = $('#sheet').dataset.snap;
  snap(cur === 'peek' ? 'half' : cur === 'half' ? 'full' : 'peek');
}

// メールアドレスは収集ボット対策として、HTML に直接書かず実行時に組み立てる
function setContactLink() {
  const user = ['kuna', '610'].join('');
  const host = ['mirai', 're'].join('.');
  const a = $('#contactLink');
  a.textContent = user + String.fromCharCode(64) + host;
  a.href = 'mai' + 'lto:' + user + String.fromCharCode(64) + host +
           '?subject=' + encodeURIComponent('秋田プレミアムチケット加盟店マップについて');
}

/* ---------------------------------------------------------
   URL への状態保存（共有できるように）
   --------------------------------------------------------- */

let hashTimer;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (store.q) p.set('q', store.q);
    if (store.cities.size) p.set('c', [...store.cities].join('.'));
    if (store.sectors.size) p.set('s', [...store.sectors].join('.'));
    if (store.ticket) p.set('t', store.ticket);
    const h = p.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname);
  }, 350);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  store.q = p.get('q') || '';
  $('#q').value = store.q;
  (p.get('c') || '').split('.').filter(Boolean).forEach((v) => store.cities.add(+v));
  (p.get('s') || '').split('.').filter(Boolean).forEach((v) => store.sectors.add(+v));
  store.ticket = +(p.get('t') || 0);
}

/* ---------------------------------------------------------
   イベント配線
   --------------------------------------------------------- */

function bindUI() {
  // 検索
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    store.q = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { apply({ fit: true }); if (store.q) snap('half'); }, 220);
  });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('#qclear').addEventListener('click', () => {
    store.q = ''; $('#q').value = '';
    store.cities.clear(); store.sectors.clear();
    store.ticket = 0;
    apply({ fit: true });
  });

  // 絞り込みパネル
  $('#filterBtn').addEventListener('click', () => {
    $('#filterPane').hidden = false;
    syncFilterUI();
  });
  $('#filterPane').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { $('#filterPane').hidden = true; fitToHits(); snap('half'); return; }
    const chip = e.target.closest('.chip');
    if (chip) { toggleFilter(chip.dataset.k, +chip.dataset.v); apply(); return; }
    const clr = e.target.closest('[data-clear]');
    if (clr) {
      (clr.dataset.clear === 'sector' ? store.sectors : store.cities).clear();
      apply();
    }
  });
  $('#fReset').addEventListener('click', () => {
    store.cities.clear(); store.sectors.clear(); store.ticket = 0;
    apply();
  });

  // 条件チップの ×
  $('#chipbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    toggleFilter(b.dataset.k, +b.dataset.v);
    apply({ fit: true });
  });

  // 一覧
  $('#detail').addEventListener('click', (e) => {
    const row = e.target.closest('.g-row');
    if (row) openDetail(+row.dataset.i, true, +$('#detail').dataset.group);
  });

  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('#btnAllEmpty')) { fitToHits(); return; }
    if (e.target.closest('#btnMore')) {
      const keep = $('#list').scrollTop;
      store.shown += PAGE * 2;
      renderList();
      $('#list').scrollTop = keep;
      return;
    }
    const row = e.target.closest('.row');
    if (row) openDetail(+row.dataset.i);
  });
  $('#list').addEventListener('scroll', () => {
    const el = $('#list');
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && store.shown < inView.length) {
      store.shown += PAGE;
      renderList();
    }
  }, { passive: true });

  // 並び替え
  // 地図まわり
  $('#btnAll').addEventListener('click', () => fitToHits());
  $('#btnLocate').addEventListener('click', locate);
  $('#btnInfo').addEventListener('click', () => {
    $('#infoCount').textContent = DATA.shops.length.toLocaleString('ja-JP');
    $('#infoDate').textContent = DATA.date.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, '$1年$2月$3日');
    $('#infoApprox').textContent =
      DATA.shops.filter((s) => s[F.PREC] > 0).length.toLocaleString('ja-JP');
    setContactLink();
    $('#infoPane').hidden = false;
  });
  $('#infoPane').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) $('#infoPane').hidden = true;
  });
  $('#btnLayer').addEventListener('click', () => {
    baseIdx = (baseIdx + 1) % BASEMAPS.length;
    setBasemap(baseIdx);
    toast(`地図：${BASEMAPS[baseIdx].label}`);
  });

  bindSheetDrag();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#infoPane').hidden) $('#infoPane').hidden = true;
      else if (!$('#filterPane').hidden) $('#filterPane').hidden = true;
      else if (!$('#detail').hidden) closeDetail();
    }
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
  });

  addEventListener('resize', () => { document.body.dataset.snap = $('#sheet').dataset.snap; });

  // 共有された URL を開いたままの状態で踏んだ場合にも条件を反映する
  addEventListener('hashchange', () => {
    store.cities.clear(); store.sectors.clear();
    readHash();
    apply({ fit: true });
  });

  snap('peek');
}
