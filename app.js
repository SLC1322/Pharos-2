// Pharos — application shell: library, reader chrome, drawers, settings, highlights.
import { db, uid } from './db.js';
import { importFile } from './parse.js';
import { Reader, STYLES } from './reader.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const DEFAULTS = { defaultStyle: 'hardcover', theme: 'day', fs: 19, lh: 1.55, mg: 22, justify: true, mode: 'paged', dir: 'ltr' };
const LEATHERS = ['#5a1f1a', '#1f3a2c', '#1d2a44', '#6b4524', '#2a1f1a', '#4a2340', '#6e2a1a', '#344030', '#3d2b1f', '#233b44', '#58401d', '#40151c'];

let settings = { ...DEFAULTS };
let books = [];
let cur = null;          // { book, content, reader, marks, texts }
let overlay = null;
let pop = null;          // selection popover state
const coverUrls = new Map();

// ------------------------------------------------------------------ utilities
const hash = s => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = f => (f * 100 < 10 ? (f * 100).toFixed(1) : Math.round(f * 100)) + '%';
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }
function busy(on, text) { $('#busy').hidden = !on; if (text) $('#busyText').textContent = text; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ------------------------------------------------------------------ boot
async function boot() {
  settings = { ...DEFAULTS, ...(await db.get('kv', 'settings') || {}) };
  books = await db.all('books');
  renderLibrary();
  bindLibrary(); bindReaderChrome(); bindDrawer(); bindSettings(); bindCard(); bindSelection();
  window.addEventListener('popstate', onPop);
  history.replaceState({ root: 1 }, '');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data === 'shared') importShared(); });
  }
  importShared();
  const last = books.filter(b => b.opened).sort((a, b) => b.opened - a.opened)[0];
  if (last && new URLSearchParams(location.search).has('resume')) openBook(last.id);
}
const saveSettings = debounce(() => db.put('kv', settings, 'settings'), 300);

// ------------------------------------------------------------------ library
function coverEl(b) {
  const d = document.createElement('div');
  d.className = 'cover';
  if (b.cover) {
    if (!coverUrls.has(b.id)) coverUrls.set(b.id, URL.createObjectURL(b.cover));
    d.innerHTML = `<img alt="" src="${coverUrls.get(b.id)}">`;
  } else {
    d.classList.add('gen');
    d.style.setProperty('--leather', LEATHERS[hash(b.title) % LEATHERS.length]);
    d.innerHTML = `<b>${escHtml(b.title)}</b>${b.author ? `<small>${escHtml(b.author)}</small>` : ''}`;
  }
  return d;
}

function renderLibrary() {
  const shelves = $('#shelves');
  shelves.innerHTML = '';
  const sorted = [...books].sort((a, b) => b.added - a.added);
  for (const b of sorted) {
    const h = hash(b.id + b.title);
    const slot = document.createElement('div');
    slot.className = 'slot';
    const w = Math.round(34 + Math.min(24, (b.total || 50000) / 28000));
    const ht = 136 + (h % 44);
    slot.innerHTML = `<div class="spine" style="--w:${w}px;--h:${ht}px;--leather:${LEATHERS[h % LEATHERS.length]}" data-id="${b.id}"><span class="t">${escHtml(b.title)}</span>${b.progress > 0.002 && b.progress < 0.995 ? '<i class="sribbon"></i>' : ''}</div>`;
    shelves.appendChild(slot);
  }
  // pad with a couple of empty rows for the look of a bookcase
  $('#emptyState').hidden = books.length > 0;
  const now = $('#nowReading');
  now.innerHTML = '';
  const reading = [...books].filter(b => b.opened && b.progress < 0.995).sort((a, b) => b.opened - a.opened)[0];
  if (reading) {
    const box = document.createElement('div');
    box.className = 'now';
    box.appendChild(coverEl(reading));
    const info = document.createElement('div');
    info.style.minWidth = '0'; info.style.flex = '1';
    info.innerHTML = `<div class="label">Now reading</div><h2>${escHtml(reading.title)}</h2><p>${escHtml(reading.author || '')}</p><div class="bar"><i style="width:${(reading.progress * 100).toFixed(1)}%"></i></div><button class="primary" data-open="${reading.id}">Continue · ${pct(reading.progress)}</button>`;
    box.appendChild(info);
    box.querySelector('.cover').addEventListener('click', () => openBook(reading.id));
    now.appendChild(box);
  }
}

function bindLibrary() {
  $('#addBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    await importFiles(files);
  });
  $('#shelves').addEventListener('click', e => { const s = e.target.closest('.spine'); if (s) showCard(s.dataset.id); });
  $('#nowReading').addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openBook(b.dataset.open); });
}

async function importFiles(files) {
  let last = null;
  for (const f of files) {
    busy(true, `Binding “${f.name}”…`);
    try {
      const book = await importFile(f);
      const id = uid();
      const rec = {
        id, title: book.meta.title, author: book.meta.author, format: book.meta.format, added: Date.now(), opened: 0,
        style: settings.defaultStyle, pos: { ch: 0, off: 0 }, progress: 0, total: book.total, toc: book.toc, cover: book.cover || null,
        pages: book.pages || 0, size: f.size, fileName: f.name,
      };
      await db.put('content', { id, chapters: book.chapters || null, images: book.images || [], pdf: book.pdf || null });
      await db.put('books', rec);
      books.push(rec);
      last = rec;
    } catch (err) {
      console.error(err);
      toast(`Couldn't open ${f.name}: ${err.message}`);
    }
  }
  busy(false);
  renderLibrary();
  if (last) { toast(`Added “${last.title}”`); navigator.storage?.persist?.(); }
}

async function importShared() {
  if (!('caches' in window)) return;
  try {
    const c = await caches.open('pharos-share');
    const keys = await c.keys();
    if (!keys.length) return;
    const files = [];
    for (const k of keys) { const r = await c.match(k); const blob = await r.blob(); files.push(new File([blob], decodeURIComponent(new URL(k.url).pathname.split('/').pop()), { type: blob.type })); await c.delete(k); }
    if (location.search.includes('shared')) history.replaceState({ root: 1 }, '', location.pathname);
    await importFiles(files);
  } catch (e) { console.warn(e); }
}

// ------------------------------------------------------------------ book card
let cardBook = null;
function showCard(id) {
  const b = books.find(x => x.id === id); if (!b) return;
  cardBook = b;
  const cv = $('#cardCover'); cv.innerHTML = ''; cv.appendChild(coverEl(b));
  $('#cardTitle').textContent = b.title;
  $('#cardAuthor').textContent = b.author || '';
  $('#cardMeta').textContent = `${b.format.toUpperCase()} · ${b.progress ? pct(b.progress) + ' read' : 'Unread'}`;
  $('#cardBar').style.width = (b.progress * 100).toFixed(1) + '%';
  $('#cardRead').textContent = b.progress > 0.002 ? 'Continue' : 'Begin reading';
  $$('#cardStyles button').forEach(x => x.classList.toggle('on', x.dataset.style === b.style));
  $('#cardStyles').parentElement.querySelector('h3').hidden = b.format === 'pdf';
  $('#cardStyles').hidden = b.format === 'pdf';
  const del = $('#cardDelete'); del.classList.remove('armed'); del.textContent = 'Remove from library';
  openOverlay($('#bookcard'));
}
function bindCard() {
  $('#cardRead').addEventListener('click', () => { const id = cardBook.id; closeOverlay(); setTimeout(() => openBook(id), 60); });
  $('#cardStyles').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    cardBook.style = b.dataset.style; await db.put('books', cardBook);
    $$('#cardStyles button').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#cardDelete').addEventListener('click', async e => {
    const btn = e.currentTarget;
    if (!btn.classList.contains('armed')) { btn.classList.add('armed'); btn.textContent = 'Tap again to remove permanently'; return; }
    await db.deleteBook(cardBook.id);
    books = books.filter(x => x.id !== cardBook.id);
    closeOverlay(); renderLibrary(); toast('Removed');
  });
}

// ------------------------------------------------------------------ overlays + back button
function openOverlay(el) {
  if (overlay) { overlay.classList.remove('on'); overlay = el; el.classList.add('on'); return; } // swap, same history entry
  overlay = el; el.classList.add('on'); $('#scrim').classList.add('on');
  history.pushState({ o: 1 }, '');
}
function closeOverlay(fromPop) {
  if (!overlay) return;
  overlay.classList.remove('on'); $('#scrim').classList.remove('on');
  $('#reader').classList.remove('tuning');
  overlay = null;
  if (!fromPop) { ignorePop++; history.back(); }
}
let ignorePop = 0;
function onPop() {
  if (ignorePop) { ignorePop--; return; }
  if (overlay) { overlay.classList.remove('on'); $('#scrim').classList.remove('on'); overlay = null; return; }
  if (cur) closeReader(true);
}
document.addEventListener('click', e => { if (e.target.id === 'scrim' || e.target.closest('[data-close]')) closeOverlay(); });

// ------------------------------------------------------------------ reader
function applyTypography() {
  const r = $('#reader');
  r.style.setProperty('--fs', settings.fs + 'px');
  r.style.setProperty('--lh', settings.lh);
  r.style.setProperty('--mg', settings.mg + 'px');
  r.style.setProperty('--align', settings.justify ? 'justify' : 'left');
  r.dataset.theme = settings.theme;
}

async function openBook(id) {
  const book = books.find(b => b.id === id); if (!book) return;
  busy(true, 'Opening…');
  const content = await db.get('content', id);
  const marks = await db.byBook(id);
  busy(false);
  if (!content) { toast('This book’s pages are missing'); return; }
  cur = { book, content, marks, texts: null };
  $('#toast').classList.remove('on');
  $('#library').hidden = true;
  $('#reader').hidden = false;
  $('#reader').classList.remove('chrome-on');
  $('#bookTitle').textContent = book.title;
  $('#bookAuthor').textContent = book.author || '';
  $('#reader').dataset.style = book.format === 'pdf' ? 'hardcover' : book.style;
  applyTypography();
  history.pushState({ r: 1 }, '');
  book.opened = Date.now(); db.put('books', book);
  await mountReader(book.pos);
  const f = document.fonts; if (f && f.status !== 'loaded') f.ready.then(() => { if (cur?.reader && cur.book === book && cur.reader.relayout) cur.reader.relayout(); });
}

async function mountReader(pos) {
  const stage = $('#stage');
  cur.reader?.destroy();
  const handlers = {
    position: onPosition,
    tap: zone => { if (zone === 'center') toggleChrome(); else { hideChrome(); hidePop(); } },
    markTap: (id, rect) => showPop('edit', { id, rect }),
    jumped: () => hideChrome(),
  };
  if (cur.book.format === 'pdf') {
    const { PdfReader } = await import('./pdfview.js');
    stage.className = 'stage';
    stage.innerHTML = '';
    cur.reader = new PdfReader(stage, cur.content.pdf, { onPosition: (p, f) => onPosition(p, f), onTap: () => toggleChrome(), startPage: pos?.ch || 0 });
    await cur.reader.init();
    return;
  }
  cur.reader = new Reader(stage, { book: cur.book, content: cur.content, settings, style: cur.book.style, marks: cur.marks, on: handlers });
  cur.reader.mount(pos);
}

const savePos = debounce(() => { if (cur) db.put('books', cur.book); }, 700);
function onPosition(pos, frac) {
  if (!cur) return;
  cur.pos = pos;
  cur.book.pos = pos; cur.book.progress = frac;
  savePos();
  updateLoc(frac, pos);
}
function tocTitleAt(pos) {
  const toc = cur.book.toc || [];
  let best = null;
  for (const t of toc) if (t.ch < pos.ch || (t.ch === pos.ch && t.off <= pos.off)) best = t;
  if (cur.book.format === 'pdf') return best ? best.title : `Page ${pos.ch + 1}`;
  return best?.title || cur.content.chapters?.[pos.ch]?.title || '';
}
function updateLoc(frac, pos) {
  const s = $('#slider');
  if (!s.dragging) { s.value = Math.round(frac * 1000); s.style.setProperty('--p', (frac * 100) + '%'); }
  $('#locChapter').textContent = tocTitleAt(pos);
  $('#locPct').textContent = cur.book.format === 'pdf' ? `${pos.ch + 1} / ${cur.book.pages}` : pct(frac);
  const bm = findBookmark();
  $('#bmBtn').classList.toggle('on', !!bm);
  $('#bmBtn use').setAttribute('href', bm ? '#i-bookmark-on' : '#i-bookmark');
}
function toggleChrome() { $('#reader').classList.toggle('chrome-on'); hidePop(); }
function hideChrome() { $('#reader').classList.remove('chrome-on'); }

function closeReader(fromPop) {
  if (!cur) return;
  try { const p = cur.reader.getPos(); cur.book.pos = p; } catch {}
  db.put('books', cur.book);
  cur.reader.destroy();
  cur = null;
  hidePop();
  $('#reader').hidden = true;
  $('#library').hidden = false;
  renderLibrary();
  if (!fromPop) { ignorePop++; history.back(); }
}

function bindReaderChrome() {
  $('#backBtn').addEventListener('click', () => closeReader(false));
  $('#bmBtn').addEventListener('click', toggleBookmark);
  $('#tocBtn').addEventListener('click', () => openDrawer('toc'));
  $('#searchBtn').addEventListener('click', () => { openDrawer('toc'); setTimeout(() => $('#searchInput').focus(), 320); });
  $('#setBtn').addEventListener('click', () => { syncSettingsUI(); $('#reader').classList.add('tuning'); openOverlay($('#settings')); });
  const s = $('#slider');
  s.addEventListener('input', () => {
    s.dragging = true;
    const f = s.value / 1000;
    s.style.setProperty('--p', (f * 100) + '%');
    if (cur.book.format === 'pdf') { $('#locPct').textContent = `${Math.round(f * (cur.book.pages - 1)) + 1} / ${cur.book.pages}`; return; }
    $('#locChapter').textContent = tocTitleAt(cur.reader.posFromFraction(f));
    $('#locPct').textContent = pct(f);
  });
  s.addEventListener('change', () => { s.dragging = false; cur.reader.goToFraction(s.value / 1000); });
  window.addEventListener('resize', debounce(() => { if (cur?.reader?.relayout) cur.reader.relayout(); }, 250));
  document.addEventListener('visibilitychange', () => { if (document.hidden && cur) { try { cur.book.pos = cur.reader.getPos(); } catch {} db.put('books', cur.book); } });
}

// ------------------------------------------------------------------ bookmarks
function findBookmark() {
  if (!cur?.pos) return null;
  const p = cur.pos;
  const span = cur.book.format === 'pdf' ? 0 : 500;
  return cur.marks.find(m => m.type === 'bm' && m.ch === p.ch && m.off >= p.off - 5 && m.off <= p.off + span);
}
async function toggleBookmark() {
  const existing = findBookmark();
  if (existing) {
    await db.del('marks', existing.id);
    cur.marks = cur.marks.filter(m => m !== existing);
    toast('Bookmark removed');
  } else {
    const p = cur.reader.getPos();
    let excerpt = '';
    if (cur.book.format !== 'pdf') excerpt = chapterText(p.ch).slice(p.off, p.off + 140).replace(/\s+/g, ' ').trim();
    const m = { id: uid(), bookId: cur.book.id, type: 'bm', ch: p.ch, off: p.off, excerpt, frac: cur.book.progress, created: Date.now() };
    await db.put('marks', m);
    cur.marks.push(m);
    toast('Page bookmarked');
  }
  if (cur.reader.marks) cur.reader.marks = cur.marks;
  cur.reader.engine?.decorate?.(cur.reader.engine.baseEl, cur.reader.engine.ch, cur.reader.engine.page, cur.reader.engine.pages);
  cur.reader.engine?.tick?.(true);
  updateLoc(cur.book.progress, cur.pos);
}

function chapterText(ch) {
  cur.texts = cur.texts || [];
  if (cur.texts[ch] == null) { const t = document.createElement('template'); t.innerHTML = cur.content.chapters[ch].html; cur.texts[ch] = t.content.textContent; }
  return cur.texts[ch];
}

// ------------------------------------------------------------------ drawer: contents / bookmarks / notes / search
let drawerTab = 'toc';
function openDrawer(tab) {
  drawerTab = tab;
  $('#searchInput').value = '';
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  $('#searchInput').parentElement.hidden = cur.book.format === 'pdf';
  renderDrawer();
  openOverlay($('#drawer'));
  requestAnimationFrame(() => $('#drawerList .here')?.scrollIntoView({ block: 'center' }));
}
function jump(pos, flashLen) {
  closeOverlay(); hideChrome();
  setTimeout(() => { cur.reader.goTo(pos); if (flashLen) setTimeout(() => cur.reader.flash?.(pos.ch, pos.off, flashLen), 60); }, 80);
}
function renderDrawer() {
  const list = $('#drawerList');
  const q = $('#searchInput').value.trim();
  if (q.length >= 2) return renderSearch(q);
  list.innerHTML = '';
  const frac = p => cur.book.format === 'pdf' ? `Page ${p.ch + 1}` : pct(cur.reader.fraction(p));
  if (drawerTab === 'toc') {
    const toc = cur.book.toc?.length ? cur.book.toc : (cur.content.chapters || []).map((c, i) => ({ title: c.title, ch: i, off: 0, level: 0 }));
    const here = tocTitleAt(cur.pos || { ch: 0, off: 0 });
    let marked = false;
    const hereIdx = (() => { let k = -1; toc.forEach((t, i) => { if (t.ch < cur.pos.ch || (t.ch === cur.pos.ch && t.off <= cur.pos.off)) k = i; }); return k; })();
    toc.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = `item lvl${Math.min(2, t.level || 0)}` + (i === hereIdx && !marked ? ' here' : '');
      if (i === hereIdx) marked = true;
      b.innerHTML = `<div class="tt">${escHtml(t.title)}</div>`;
      b.onclick = () => jump({ ch: t.ch, off: t.off });
      list.appendChild(b);
    });
    if (!toc.length) list.innerHTML = '<div class="list-empty">No table of contents</div>';
    void here;
  } else if (drawerTab === 'bm') {
    const bms = cur.marks.filter(m => m.type === 'bm').sort((a, b) => a.ch - b.ch || a.off - b.off);
    if (!bms.length) list.innerHTML = '<div class="list-empty">No bookmarks yet.<br>Tap the ribbon at the top of the page to mark your place.</div>';
    for (const m of bms) {
      const b = document.createElement('div');
      b.className = 'item';
      b.innerHTML = `<div class="tt">${escHtml(tocTitleAt(m))}</div><div class="sub">${frac(m)}${m.excerpt ? ' · ' + escHtml(m.excerpt.slice(0, 90)) + '…' : ''}</div>`;
      b.onclick = () => jump({ ch: m.ch, off: m.off });
      list.appendChild(b);
    }
  } else {
    const hls = cur.marks.filter(m => m.type === 'hl').sort((a, b) => a.ch - b.ch || a.start - b.start);
    if (!hls.length) list.innerHTML = '<div class="list-empty">No highlights or notes yet.<br>Press and hold on the text to mark a passage.</div>';
    const colors = { gold: '#e2bf5a', rose: '#d98a8a', sage: '#93b183', azure: '#7fa8cf' };
    for (const m of hls) {
      const b = document.createElement('div');
      b.className = 'item';
      b.innerHTML = `<div class="quote" style="--sw:${colors[m.color]}">${escHtml(m.text.length > 260 ? m.text.slice(0, 260) + '…' : m.text)}</div>${m.note ? `<div class="gloss">✎ ${escHtml(m.note)}</div>` : ''}<div class="sub">${escHtml(tocTitleAt({ ch: m.ch, off: m.start }))} · ${frac({ ch: m.ch, off: m.start })}</div>`;
      b.onclick = () => jump({ ch: m.ch, off: m.start }, 0);
      list.appendChild(b);
    }
  }
}
function renderSearch(q) {
  const list = $('#drawerList');
  const needle = q.toLowerCase();
  const results = [];
  const chs = cur.content.chapters;
  for (let ch = 0; ch < chs.length && results.length < 300; ch++) {
    const text = chapterText(ch), low = text.toLowerCase();
    let i = low.indexOf(needle);
    while (i >= 0 && results.length < 300) { results.push({ ch, off: i, text }); i = low.indexOf(needle, i + needle.length); }
  }
  list.innerHTML = `<div class="list-empty" style="padding:12px 18px;text-align:left;font-size:14px">${results.length >= 300 ? '300+' : results.length} result${results.length === 1 ? '' : 's'}</div>`;
  for (const r of results) {
    const a = Math.max(0, r.off - 50), z = Math.min(r.text.length, r.off + q.length + 70);
    const snip = (a ? '…' : '') + escHtml(r.text.slice(a, r.off)) + '<mark>' + escHtml(r.text.slice(r.off, r.off + q.length)) + '</mark>' + escHtml(r.text.slice(r.off + q.length, z)) + (z < r.text.length ? '…' : '');
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = `<div class="quote" style="font-style:normal;border:0;padding:0">${snip.replace(/\s+/g, ' ')}</div><div class="sub">${escHtml(tocTitleAt(r))} · ${pct(cur.reader.fraction(r))}</div>`;
    b.onclick = () => jump({ ch: r.ch, off: r.off }, q.length);
    list.appendChild(b);
  }
}
function bindDrawer() {
  $$('.tab').forEach(t => t.addEventListener('click', () => { drawerTab = t.dataset.tab; $('#searchInput').value = ''; $$('.tab').forEach(x => x.classList.toggle('on', x === t)); renderDrawer(); }));
  $('#searchInput').addEventListener('input', debounce(renderDrawer, 250));
}

// ------------------------------------------------------------------ settings sheet
function syncSettingsUI() {
  const style = cur?.book.style || settings.defaultStyle;
  $$('#styleSwatches button').forEach(b => b.classList.toggle('on', b.dataset.style === style));
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme));
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));
  $$('#dirSeg button').forEach(b => b.classList.toggle('on', b.dataset.dir === settings.dir));
  for (const [id, key, fmt] of [['fs', 'fs', v => v], ['lh', 'lh', v => (+v).toFixed(2)], ['mg', 'mg', v => v]]) {
    const r = $('#' + id + 'Range'); r.value = settings[key]; $('#' + id + 'Out').textContent = fmt(settings[key]);
    r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
  }
  $('#justifyTgl').classList.toggle('on', settings.justify);
  const pap = style === 'papyrus', pdf = cur?.book.format === 'pdf';
  $('#codexOnly').hidden = pap || pdf;
  $('#papyrusNote').hidden = !pap;
  $('#dirRow').hidden = settings.mode === 'scroll';
  $('#styleSwatches').hidden = pdf;
  $('#styleSwatches').previousElementSibling.hidden = pdf;
}
async function remount() {
  if (!cur || cur.book.format === 'pdf') return;
  const pos = cur.reader.getPos();
  $('#reader').dataset.style = cur.book.style;
  await mountReader(pos);
}
const relayoutSoon = debounce(() => cur?.reader?.relayout?.(), 180);
function bindSettings() {
  $('#styleSwatches').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !cur) return;
    cur.book.style = b.dataset.style; settings.defaultStyle = b.dataset.style;
    db.put('books', cur.book); saveSettings();
    syncSettingsUI(); await remount();
  });
  $('#themeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; settings.theme = b.dataset.theme; saveSettings(); applyTypography(); syncSettingsUI(); });
  $('#modeSeg').addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; settings.mode = b.dataset.mode; saveSettings(); syncSettingsUI(); await remount(); });
  $('#dirSeg').addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; settings.dir = b.dataset.dir; saveSettings(); syncSettingsUI(); await remount(); });
  for (const [id, key, parse, fmt] of [['fs', 'fs', parseInt, v => v], ['lh', 'lh', parseFloat, v => v.toFixed(2)], ['mg', 'mg', parseInt, v => v]]) {
    const r = $('#' + id + 'Range');
    r.addEventListener('input', () => {
      settings[key] = parse(r.value); $('#' + id + 'Out').textContent = fmt(settings[key]);
      r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min) * 100) + '%');
      applyTypography(); saveSettings(); relayoutSoon();
    });
  }
  $('#justifyTgl').addEventListener('click', () => { settings.justify = !settings.justify; applyTypography(); syncSettingsUI(); saveSettings(); relayoutSoon(); });
}

// ------------------------------------------------------------------ selection, highlights, notes
function bindSelection() {
  const check = debounce(() => {
    if (!cur || cur.book.format === 'pdf' || overlay) return;
    const sel = getSelection();
    if (sel.isCollapsed || !sel.rangeCount) { if (pop?.mode === 'new') hidePop(); return; }
    const range = sel.getRangeAt(0);
    if (!$('#stage').contains(range.commonAncestorContainer)) return;
    const info = cur.reader.rangeInfo(range);
    if (!info || !info.text.trim()) return;
    showPop('new', { info, rect: range.getBoundingClientRect() });
  }, 280);
  document.addEventListener('selectionchange', check);
  $('#selpop').addEventListener('pointerdown', e => e.preventDefault()); // keep the selection alive
  $('#selpop').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !pop) return;
    if (b.dataset.color) await setColor(b.dataset.color);
    else if (b.dataset.act === 'note') { const m = pop.mode === 'new' ? await createMark('gold') : cur.marks.find(x => x.id === pop.id); hidePop(); openNote(m); }
    else if (b.dataset.act === 'copy') { const t = pop.mode === 'new' ? pop.info.text : cur.marks.find(x => x.id === pop.id)?.text; try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Copy not available'); } getSelection().removeAllRanges(); hidePop(); }
    else if (b.dataset.act === 'delete') { const m = cur.marks.find(x => x.id === pop.id); if (m) { await db.del('marks', m.id); cur.marks = cur.marks.filter(x => x !== m); cur.reader.marks = cur.marks; cur.reader.refreshMarks(m.ch); } hidePop(); }
  });
  $('#noteCancel').addEventListener('click', () => closeOverlay());
  $('#noteSave').addEventListener('click', async () => {
    const m = noteMark; if (!m) return;
    m.note = $('#noteText').value.trim();
    await db.put('marks', m);
    cur.reader.refreshMarks(m.ch);
    closeOverlay(); toast(m.note ? 'Note saved' : 'Note cleared');
  });
}
async function createMark(color) {
  const { ch, start, end, text } = pop.info;
  const m = { id: uid(), bookId: cur.book.id, type: 'hl', ch, start, end, text, color, note: '', created: Date.now() };
  await db.put('marks', m);
  cur.marks.push(m); cur.reader.marks = cur.marks;
  getSelection().removeAllRanges();
  cur.reader.refreshMarks(ch);
  return m;
}
async function setColor(color) {
  if (pop.mode === 'new') await createMark(color);
  else { const m = cur.marks.find(x => x.id === pop.id); if (m) { m.color = color; await db.put('marks', m); cur.reader.refreshMarks(m.ch); } }
  hidePop();
}
function showPop(mode, data) {
  if (mode === 'edit' && $('#reader').classList.contains('chrome-on')) hideChrome();
  pop = { mode, ...data };
  const el = $('#selpop');
  el.hidden = false;
  el.querySelector('[data-act=delete]').hidden = mode === 'new';
  const m = mode === 'edit' ? cur.marks.find(x => x.id === data.id) : null;
  el.querySelectorAll('.ink').forEach(i => i.classList.toggle('on', !!m && i.dataset.color === m.color));
  const r = data.rect, w = el.offsetWidth, h = el.offsetHeight;
  let top = r.bottom + 16;
  if (top + h > innerHeight - 20) top = Math.max(10, r.top - h - 60);
  el.style.top = top + 'px';
  el.style.left = Math.max(10, Math.min(innerWidth - w - 10, r.left + r.width / 2 - w / 2)) + 'px';
}
function hidePop() { pop = null; $('#selpop').hidden = true; }
let noteMark = null;
function openNote(m) {
  noteMark = m;
  $('#noteQuote').textContent = m.text;
  $('#noteText').value = m.note || '';
  openOverlay($('#noteDlg'));
  setTimeout(() => $('#noteText').focus(), 340);
}

// test hooks (harmless in production)
window.pharosGo = pos => cur?.reader?.goTo(pos);
window.pharosFlip = t => { const e = cur?.reader?.engine; if (!e?.prepare) return; if (!e._job) e._job = e.prepare(true); e.setAngle(t); };
boot();
