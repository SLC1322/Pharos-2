// Pharos — reading engines: paged codex (3D leaf turns), continuous scroll, and the papyrus scroll.
import { textNodes, locate, offsetOf, charRect, wrapRange } from './textmap.js';

export const STYLES = {
  hardcover: { name: 'Modern Hardcover', dur: 560, ease: 'outCubic', curl: 1, folio: 'arabic' },
  manuscript: { name: 'Medieval Manuscript', dur: 950, ease: 'inOutSine', curl: 0.2, folio: 'roman' },
  tome: { name: 'Sheepskin Tome', dur: 1150, ease: 'heavy', curl: 0.45, folio: 'arabic' },
  papyrus: { name: 'Papyrus Scroll', folio: 'none' },
};

const EASE = {
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  // slow lift, heavy fall, small settle bounce
  heavy: t => {
    if (t < 0.4) return 0.3 * Math.pow(t / 0.4, 2);
    const x = (t - 0.4) / 0.6, c1 = 0.9, c3 = c1 + 1;
    return 0.3 + 0.7 * (1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2));
  },
  linear: t => t,
};

export function roman(n) {
  const m = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = ''; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s;
}

export class Reader {
  // opts: { book, content, settings, style, marks, on:{position, tap, markTap, selectionHint} }
  constructor(stage, opts) {
    Object.assign(this, opts);
    this.stage = stage;
    this.urls = new Map();
    this.chStart = [];
    let acc = 0;
    for (const c of this.content.chapters) { this.chStart.push(acc); acc += c.len; }
    this.total = acc || 1;
  }
  imgUrl(i) {
    if (!this.urls.has(i)) { const b = this.content.images?.[i]; this.urls.set(i, b ? URL.createObjectURL(b) : ''); }
    return this.urls.get(i);
  }
  fill(root, ch) {
    root.innerHTML = this.content.chapters[ch].html;
    root.dataset.ch = ch;
    root.classList.add('ch-root');
    for (const im of root.querySelectorAll('img[data-img]')) {
      im.src = this.imgUrl(+im.dataset.img);
      im.decoding = 'async';
    }
    const first = [...root.querySelectorAll('p')].find(p => p.textContent.trim().length > 40 && !p.closest('blockquote,table,.x-verse'));
    if (first) first.classList.add('first-para');
    this.applyMarks(root, ch);
  }
  applyMarks(root, ch) {
    for (const m of this.marks) {
      if (m.type !== 'hl' || m.ch !== ch) continue;
      const els = wrapRange(root, m.start, m.end, () => { const e = document.createElement('mark'); e.className = 'hl c-' + m.color; e.dataset.id = m.id; return e; });
      if (m.note && els.length) els[els.length - 1].classList.add('note-end');
    }
  }
  fraction(pos) { return Math.min(1, (this.chStart[pos.ch] + pos.off) / this.total); }
  posFromFraction(f) {
    const target = f * this.total;
    let ch = 0;
    while (ch < this.chStart.length - 1 && this.chStart[ch + 1] <= target) ch++;
    return { ch, off: Math.max(0, Math.round(target - this.chStart[ch])) };
  }
  mount(pos) {
    this.stage.innerHTML = '';
    this.stage.className = 'stage';
    this.engine = this.style === 'papyrus' ? new ScrollEngine(this, 'x')
      : this.settings.mode === 'scroll' ? new ScrollEngine(this, 'y')
        : new PagedEngine(this, this.settings.dir);
    this.engine.mount();
    this.engine.goTo(pos || { ch: 0, off: 0 });
  }
  report(pos) { this.lastPos = pos; this.on.position(pos, this.fraction(pos)); }
  goTo(pos) { this.engine.goTo(pos); }
  goToFraction(f) { this.engine.goTo(this.posFromFraction(f)); }
  next() { this.engine.next(); }
  prev() { this.engine.prev(); }
  getPos() { return this.engine.getPos(); }
  relayout() { const p = this.engine.getPos(); this.engine.relayout?.(); this.engine.goTo(p); }
  refreshMarks(ch) { this.engine.refreshMarks(ch); }
  rootFor(node) { const el = node.nodeType === 1 ? node : node.parentElement; return el?.closest('.ch-root'); }
  rangeInfo(range) {
    const root = this.rootFor(range.startContainer);
    if (!root || root !== this.rootFor(range.endContainer)) return null;
    const ch = +root.dataset.ch;
    const start = offsetOf(root, range.startContainer, range.startOffset);
    const end = offsetOf(root, range.endContainer, range.endOffset);
    if (end <= start) return null;
    return { ch, start, end, text: range.toString() };
  }
  flash(ch, off, len) {
    for (const root of this.stage.querySelectorAll(`.ch-root[data-ch="${ch}"]`)) {
      const els = wrapRange(root, off, off + len, () => { const e = document.createElement('span'); e.className = 'flash'; return e; });
      setTimeout(() => els.forEach(e => { if (e.parentNode) { e.replaceWith(...e.childNodes); } }), 2200);
    }
  }
  handleTap(e, zone) {
    const t = e.target;
    const hl = t.closest?.('mark.hl');
    if (hl) { this.on.markTap(hl.dataset.id, hl.getBoundingClientRect()); return; }
    const a = t.closest?.('a');
    if (a) {
      if (a.dataset.href) { const [ch, off] = a.dataset.href.split(':').map(Number); e.preventDefault?.(); this.goTo({ ch, off }); this.on.jumped?.(); return; }
      if (a.getAttribute('href')) return; // external link: default
    }
    this.on.tap(zone);
  }
  destroy() {
    this.engine?.destroy?.();
    for (const u of this.urls.values()) if (u) URL.revokeObjectURL(u);
    this.stage.innerHTML = '';
  }
}

// ------------------------------------------------------------------ Paged codex
const PAGE_HTML = `<div class="page-inner"><div class="head"></div><div class="viewport"><div class="flow"></div></div><div class="folio"></div></div><div class="deco"></div><div class="curl"></div>`;

class Flow {
  constructor(el, eng) { this.el = el; this.eng = eng; this.ch = -1; this.map = null; }
  load(ch, force) { if (this.ch === ch && !force) return; this.eng.r.fill(this.el, ch); this.ch = ch; this.map = null; this.el.querySelectorAll('img').forEach(i => i.addEventListener('load', () => this.eng.onImageLoad(this), { once: true })); }
  get pages() { const { W, G } = this.eng; return Math.max(1, Math.round((this.el.scrollWidth + G) / (W + G))); }
  show(p) { this.page = p; this.el.style.transform = `translate3d(${-p * (this.eng.W + this.eng.G)}px,0,0)`; }
  getMap() { return this.map || (this.map = textNodes(this.el)); }
  pageOf(off) {
    const map = this.getMap();
    if (!map.total) return 0;
    const r = charRect(map, Math.min(off, map.total - 1));
    if (!r) return 0;
    const fr = this.el.getBoundingClientRect();
    return Math.max(0, Math.min(this.pages - 1, Math.floor((r.left - fr.left + 2) / (this.eng.W + this.eng.G))));
  }
  offOf(p) {
    if (p <= 0) return 0;
    const map = this.getMap();
    let lo = 0, hi = map.total;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.pageOf(mid) >= p) hi = mid; else lo = mid + 1; }
    return lo;
  }
}

class PagedEngine {
  constructor(r, dir) { this.r = r; this.dir = dir === 'btt' ? 'btt' : 'ltr'; this.G = 48; this.busy = null; }
  get st() { return STYLES[this.r.style]; }
  mount() {
    const s = this.r.stage;
    s.classList.add('paged', 'dir-' + this.dir);
    s.innerHTML = `<div class="book">
      <div class="stack stack-read"></div><div class="stack stack-left"></div>
      <div class="page base">${PAGE_HTML}</div>
      <div class="cast"></div>
      <div class="leaf"><div class="face front page">${PAGE_HTML}</div><div class="face back"><div class="back-tex"></div><div class="back-shade"></div></div></div>
      <div class="ribbon" hidden></div>
    </div>`;
    this.book = s.querySelector('.book');
    this.baseEl = s.querySelector('.page.base');
    this.leafEl = s.querySelector('.leaf');
    this.cast = s.querySelector('.cast');
    this.base = new Flow(this.baseEl.querySelector('.flow'), this);
    this.leaf = new Flow(this.leafEl.querySelector('.flow'), this);
    this.leafEl.style.visibility = 'hidden';
    this.measure();
    this.bind();
  }
  measure() {
    const vp = this.baseEl.querySelector('.viewport');
    this.W = Math.floor(vp.clientWidth);
    this.H = Math.floor(vp.clientHeight);
    for (const f of [this.base, this.leaf]) {
      Object.assign(f.el.style, { width: this.W + 'px', height: this.H + 'px', columnWidth: this.W + 'px', columnGap: this.G + 'px' });
      f.map = null;
    }
    this.r.stage.style.setProperty('--img-max-h', (this.H - 8) + 'px');
  }
  relayout() { this.measure(); this.base.ch = -1; this.leaf.ch = -1; }
  onImageLoad(flow) {
    if (flow !== this.base || this.busy) return;
    const off = this.anchorOff ?? 0;
    flow.map = null; this.pages = flow.pages;
    this.base.show(flow.pageOf(off)); this.page = this.base.page; this.decorate(this.baseEl, this.ch, this.page, this.pages);
  }
  goTo(pos) {
    this.finishNow();
    const ch = Math.max(0, Math.min(this.r.content.chapters.length - 1, pos.ch));
    this.base.load(ch);
    this.ch = ch; this.pages = this.base.pages;
    this.page = this.base.pageOf(pos.off || 0);
    this.base.show(this.page);
    this.anchorOff = pos.off || 0;
    this.decorate(this.baseEl, ch, this.page, this.pages);
    this.reportSoon();
  }
  reportSoon() {
    clearTimeout(this.rt);
    this.rt = setTimeout(() => { this.anchorOff = this.base.offOf(this.page); this.r.report({ ch: this.ch, off: this.anchorOff }); }, 30);
  }
  getPos() { return { ch: this.ch, off: this.base.offOf(this.page) }; }
  folioText(ch, page, pages) {
    const len = this.r.content.chapters[ch].len || 1;
    const cpp = Math.max(200, len / pages);
    const n = Math.round(this.r.chStart[ch] / cpp) + page + 1;
    return this.st.folio === 'roman' ? 'fol. ' + roman(n) : String(n);
  }
  decorate(pageEl, ch, page, pages) {
    const c = this.r.content.chapters[ch];
    pageEl.querySelector('.head').textContent = page === 0 ? '' : (this.r.style === 'hardcover' && page % 2 ? this.r.book.title : c.title);
    pageEl.querySelector('.folio').textContent = this.folioText(ch, page, pages);
    pageEl.classList.toggle('chapter-open', page === 0);
    if (pageEl === this.baseEl) {
      const f = this.r.fraction({ ch, off: (c.len * page) / pages });
      this.book.style.setProperty('--read', f.toFixed(4));
      const bm = this.r.marks.some(m => m.type === 'bm' && m.ch === ch && m.off >= this.base.offOf(page) && m.off < (page + 1 < pages ? this.base.offOf(page + 1) : Infinity));
      this.book.querySelector('.ribbon').hidden = !bm;
    }
  }
  targetNext() {
    if (this.page < this.pages - 1) return { ch: this.ch, page: this.page + 1 };
    if (this.ch < this.r.content.chapters.length - 1) return { ch: this.ch + 1, page: 0 };
    return null;
  }
  // ---- flips
  prepare(forward) {
    const from = { ch: this.ch, page: this.page, pages: this.pages };
    if (forward) {
      const to = this.targetNext();
      if (!to) return null;
      this.leaf.load(from.ch); this.leaf.show(from.page);
      this.decorate(this.leafEl, from.ch, from.page, from.pages);
      this.leafEl.style.visibility = 'visible';
      this.setAngle(0, true);
      this.base.load(to.ch); to.pages = this.base.pages; this.base.show(to.page);
      this.ch = to.ch; this.page = to.page; this.pages = to.pages;
      this.decorate(this.baseEl, to.ch, to.page, to.pages);
      return { forward, from, to };
    } else {
      let to;
      if (this.page > 0) to = { ch: this.ch, page: this.page - 1, pages: this.pages };
      else if (this.ch > 0) { this.leaf.load(this.ch - 1); const n = this.leaf.pages; to = { ch: this.ch - 1, page: n - 1, pages: n }; }
      else return null;
      this.leaf.load(to.ch); this.leaf.show(to.page);
      this.decorate(this.leafEl, to.ch, to.page, to.pages);
      this.leafEl.style.visibility = 'visible';
      this.setAngle(1, true);
      return { forward, from, to };
    }
  }
  // t: 0 = leaf flat over base, 1 = fully turned away
  setAngle(t, instant) {
    const a = t * 180;
    this.leafEl.style.transform = this.dir === 'ltr' ? `rotateY(${-a}deg)` : `rotateX(${a}deg)`;
    const s = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
    const curl = this.st.curl;
    this.leafEl.style.setProperty('--curl', (s * (0.35 + 0.65 * curl)).toFixed(3));
    this.leafEl.style.setProperty('--t', t.toFixed(3));
    this.cast.style.opacity = (s * 0.55).toFixed(3);
    this.cast.style.setProperty('--t', t.toFixed(3));
    this.cast.style.setProperty('--edge', Math.max(0, Math.cos(Math.PI * Math.min(1, t))).toFixed(3));
    this.leafEl.classList.toggle('past-half', t > 0.5);
  }
  animate(t0, t1, dur, ease, done) {
    const e = EASE[ease] || EASE.outCubic;
    const start = performance.now();
    const step = now => {
      const k = Math.min(1, (now - start) / dur);
      this.setAngle(t0 + (t1 - t0) * e(k));
      if (k < 1) this.raf = requestAnimationFrame(step); else { this.busy = null; done(); }
    };
    this.busy = { done };
    this.raf = requestAnimationFrame(step);
  }
  finishNow() {
    if (!this.busy) return;
    cancelAnimationFrame(this.raf);
    const d = this.busy.done; this.busy = null; d();
  }
  endFlip(job, completed) {
    this.leafEl.style.visibility = 'hidden';
    this.cast.style.opacity = 0;
    if (job.forward && !completed) { // restore base
      this.base.load(job.from.ch); this.base.show(job.from.page);
      Object.assign(this, { ch: job.from.ch, page: job.from.page, pages: job.from.pages });
    }
    if (!job.forward && completed) {
      this.base.load(job.to.ch); this.base.show(job.to.page);
      Object.assign(this, { ch: job.to.ch, page: job.to.page, pages: job.to.pages });
    }
    this.decorate(this.baseEl, this.ch, this.page, this.pages);
    this.reportSoon();
  }
  turn(forward) {
    this.finishNow();
    const job = this.prepare(forward);
    if (!job) { this.bump(forward); return; }
    const st = this.st;
    this.animate(forward ? 0 : 1, forward ? 1 : 0, st.dur, st.ease, () => this.endFlip(job, true));
  }
  bump(forward) { this.book.animate([{ transform: 'none' }, { transform: `translate${this.dir === 'ltr' ? 'X' : 'Y'}(${forward ? -8 : 8}px)` }, { transform: 'none' }], { duration: 260 }); }
  next() { this.turn(true); }
  prev() { this.turn(false); }
  refreshMarks(ch) {
    if (this.base.ch === ch) { const p = this.page; this.base.load(ch, true); this.base.show(p); this.decorate(this.baseEl, this.ch, this.page, this.pages); }
    if (this.leaf.ch === ch) this.leaf.ch = -1;
  }
  bind() {
    const s = this.r.stage;
    let d = null;
    const axis = e => this.dir === 'ltr' ? e.clientX : e.clientY;
    const cross = e => this.dir === 'ltr' ? e.clientY : e.clientX;
    const size = () => this.dir === 'ltr' ? this.book.clientWidth : this.book.clientHeight;
    this.onDown = e => {
      if (e.button > 0) return;
      d = { a0: axis(e), c0: cross(e), t0: performance.now(), drag: null, e, id: e.pointerId };
    };
    this.onMove = e => {
      if (!d || e.pointerId !== d.id) return;
      const da = axis(e) - d.a0, dc = cross(e) - d.c0;
      if (!d.drag) {
        if (Math.abs(da) < 14 || Math.abs(da) < Math.abs(dc) * 1.2) return;
        if (!window.getSelection().isCollapsed) { d = null; return; }
        this.finishNow();
        const job = this.prepare(da < 0);
        if (!job) { d = null; this.bump(da < 0); return; }
        d.drag = job;
        try { s.setPointerCapture(e.pointerId); } catch {}
      }
      // the free edge of the leaf follows the finger: edge = cos(angle)
      const edge = Math.max(-1, Math.min(1, (d.drag.forward ? 1 : -1) + da / size()));
      const t = Math.acos(edge) / Math.PI;
      d.k = d.drag.forward ? t : 1 - t; d.last = { da, t: performance.now() };
      this.setAngle(t);
    };
    this.onUp = e => {
      if (!d || e.pointerId !== d.id) return;
      const job = d.drag;
      if (job) {
        const dt = Math.max(1, performance.now() - d.t0);
        const v = Math.abs(d.last?.da || 0) / dt; // px/ms
        const done = d.k > 0.33 || v > 0.45;
        const cur = job.forward ? d.k : 1 - d.k;
        const target = job.forward ? (done ? 1 : 0) : (done ? 0 : 1);
        const dur = Math.max(180, this.st.dur * Math.abs(target - cur));
        this.animate(cur, target, dur, this.r.style === 'tome' && done ? 'heavy' : 'outCubic', () => this.endFlip(job, done));
      } else if (performance.now() - d.t0 < 450 && window.getSelection().isCollapsed) {
        const rect = this.book.getBoundingClientRect();
        const pos = this.dir === 'ltr' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
        const zone = pos < 0.28 ? 'prev' : pos > 0.72 ? 'next' : 'center';
        const hitsMark = e.target.closest?.('mark.hl, a');
        if (hitsMark) this.r.handleTap(e, zone);
        else if (zone === 'next') { this.r.on.tap('turn'); this.next(); }
        else if (zone === 'prev') { this.r.on.tap('turn'); this.prev(); }
        else this.r.handleTap(e, 'center');
      }
      d = null;
    };
    this.onCancel = () => { if (d?.drag) { const job = d.drag; this.animate(job.forward ? d.k : 1 - d.k, job.forward ? 0 : 1, 200, 'outCubic', () => this.endFlip(job, false)); } d = null; };
    this.onKey = e => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') this.next(); else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') this.prev(); };
    this.onWheel = e => { if (Math.abs(e.deltaY) + Math.abs(e.deltaX) < 20 || this.busy) return; (e.deltaY + e.deltaX > 0) ? this.next() : this.prev(); };
    s.addEventListener('pointerdown', this.onDown);
    s.addEventListener('pointermove', this.onMove);
    s.addEventListener('pointerup', this.onUp);
    s.addEventListener('pointercancel', this.onCancel);
    s.addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('keydown', this.onKey);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    const s = this.r.stage;
    s.removeEventListener('pointerdown', this.onDown); s.removeEventListener('pointermove', this.onMove);
    s.removeEventListener('pointerup', this.onUp); s.removeEventListener('pointercancel', this.onCancel);
    s.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('keydown', this.onKey);
  }
}

// ------------------------------------------------------------------ Continuous scroll (y) and papyrus (x)
class ScrollEngine {
  constructor(r, axis) { this.r = r; this.axis = axis; this.secs = new Map(); }
  mount() {
    const s = this.r.stage;
    s.classList.add(this.axis === 'x' ? 'papyrus-mode' : 'scroll-mode');
    s.innerHTML = this.axis === 'x'
      ? `<div class="psheet"><div class="scroller"><div class="band"></div></div></div>
         <div class="roll roll-l"><i class="knob top"></i><i class="knob bottom"></i></div>
         <div class="roll roll-r"><i class="knob top"></i><i class="knob bottom"></i></div>`
      : `<div class="scroller"><div class="band"></div></div><div class="ribbon" hidden></div>`;
    this.sc = s.querySelector('.scroller');
    this.band = s.querySelector('.band');
    this.measure();
    this.onScroll = () => { if (this.raf) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.tick(); }); };
    this.sc.addEventListener('scroll', this.onScroll, { passive: true });
    let d = null;
    this.onDown = e => { d = { x: e.clientX, y: e.clientY, t: performance.now() }; };
    this.onUp = e => {
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved < 10 && performance.now() - d.t < 450 && window.getSelection().isCollapsed) {
        const rect = this.sc.getBoundingClientRect();
        const pos = this.axis === 'x' ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
        const zone = pos < 0.25 ? 'prev' : pos > 0.75 ? 'next' : 'center';
        if (e.target.closest?.('mark.hl, a')) this.r.handleTap(e, zone);
        else if (zone === 'center') this.r.handleTap(e, 'center');
        else { this.r.on.tap('turn'); zone === 'next' ? this.next() : this.prev(); }
      }
      d = null;
    };
    this.sc.addEventListener('pointerdown', this.onDown);
    this.sc.addEventListener('pointerup', this.onUp);
    if (this.axis === 'x') {
      // vertical wheel / vertical swipes unroll the scroll sideways
      this.onWheel = e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.sc.scrollLeft += e.deltaY; e.preventDefault(); } };
      this.sc.addEventListener('wheel', this.onWheel, { passive: false });
    }
    this.onKey = e => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); this.next(); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); this.prev(); } };
    document.addEventListener('keydown', this.onKey);
  }
  measure() {
    if (this.axis === 'x') {
      const sw = this.sc.clientWidth;
      this.colGap = 44;
      this.colW = Math.max(220, Math.min(sw - 2 * this.colGap - 40, 560));
      this.band.style.columnWidth = this.colW + 'px';
      this.band.style.columnGap = this.colGap + 'px';
      this.band.style.width = this.colW + 'px';
      this.band.style.marginLeft = ((sw - this.colW) / 2) + 'px';
      this.band.style.marginRight = ((sw - this.colW) / 2) + 'px';
      this.band.style.height = Math.floor(this.sc.clientHeight) + 'px';
      this.r.stage.style.setProperty('--img-max-h', (this.sc.clientHeight - 20) + 'px');
    }
  }
  relayout() { this.measure(); }
  stride() { return this.colW + this.colGap; }
  makeSec(ch) {
    const el = document.createElement('section');
    el.className = 'chap';
    this.r.fill(el, ch);
    this.secs.set(ch, el);
    return el;
  }
  extent() { return this.axis === 'x' ? this.sc.scrollWidth : this.sc.scrollHeight; }
  get scrollPos() { return this.axis === 'x' ? this.sc.scrollLeft : this.sc.scrollTop; }
  set scrollPos(v) { if (this.axis === 'x') this.sc.scrollLeft = v; else this.sc.scrollTop = v; }
  viewSize() { return this.axis === 'x' ? this.sc.clientWidth : this.sc.clientHeight; }
  loaded() { return [...this.secs.keys()].sort((a, b) => a - b); }
  append() { const l = this.loaded(); const n = l[l.length - 1] + 1; if (n >= this.r.content.chapters.length) return false; this.band.appendChild(this.makeSec(n)); return true; }
  prepend() {
    const f = this.loaded()[0] - 1; if (f < 0) return false;
    const before = this.extent(), pos = this.scrollPos;
    this.band.insertBefore(this.makeSec(f), this.band.firstChild);
    this.scrollPos = pos + (this.extent() - before);
    return true;
  }
  trim() {
    const l = this.loaded(); if (l.length <= 5) return;
    const cur = this.getPos().ch;
    const far = Math.abs(l[0] - cur) > Math.abs(l[l.length - 1] - cur) ? l[0] : l[l.length - 1];
    const el = this.secs.get(far);
    if (far === l[0]) { const before = this.extent(), pos = this.scrollPos; el.remove(); this.secs.delete(far); this.scrollPos = pos - (before - this.extent()); }
    else { el.remove(); this.secs.delete(far); }
  }
  ensure() {
    let guard = 0;
    while (this.scrollPos + this.viewSize() * 2.5 > this.extent() && this.append() && guard++ < 6);
    if (this.scrollPos < this.viewSize() * 0.8) this.prepend();
    this.trim();
  }
  goTo(pos) {
    const ch = Math.max(0, Math.min(this.r.content.chapters.length - 1, pos.ch));
    if (!this.secs.has(ch)) { this.band.innerHTML = ''; this.secs.clear(); this.band.appendChild(this.makeSec(ch)); }
    const el = this.secs.get(ch);
    const map = textNodes(el);
    const r = map.total ? charRect(map, Math.min(pos.off || 0, map.total - 1)) : el.getBoundingClientRect();
    const sr = this.sc.getBoundingClientRect();
    if (this.axis === 'x') {
      const br = this.band.getBoundingClientRect();
      const col = Math.floor((r.left - br.left + 2) / this.stride());
      this.scrollPos = col * this.stride();
    } else {
      this.scrollPos = this.scrollPos + (r.top - sr.top) - 28;
    }
    // fill around without moving the anchor
    let guard = 0;
    while (this.scrollPos + this.viewSize() * 2.5 > this.extent() && this.append() && guard++ < 6);
    if (ch > 0 && this.scrollPos < this.viewSize()) this.prepend();
    this.tick(true);
  }
  tick(force) {
    this.ensure();
    const now = performance.now();
    if (!force && now - (this.lastReport || 0) < 120) { clearTimeout(this.rt); this.rt = setTimeout(() => this.tick(true), 140); return; }
    this.lastReport = now;
    const pos = this.getPos();
    this.pos = pos;
    const f = this.r.fraction(pos);
    this.r.stage.style.setProperty('--read', f.toFixed(4));
    if (this.axis === 'y') {
      const bm = this.r.marks.some(m => m.type === 'bm' && m.ch === pos.ch && Math.abs(m.off - pos.off) < 400);
      this.r.stage.querySelector('.ribbon').hidden = !bm;
    }
    this.r.report(pos);
  }
  getPos() {
    const sr = this.sc.getBoundingClientRect();
    const edge = this.axis === 'x' ? sr.left + (sr.width - this.colW) / 2 - 4 : sr.top + 2;
    let sec = null;
    for (const ch of this.loaded()) {
      const el = this.secs.get(ch), r = el.getBoundingClientRect();
      if ((this.axis === 'x' ? r.right : r.bottom) > edge) { sec = el; break; }
    }
    if (!sec) { const l = this.loaded(); return { ch: l[l.length - 1] ?? 0, off: 0 }; }
    const map = textNodes(sec);
    let lo = 0, hi = map.total;
    const past = off => { const r = charRect(map, off); if (!r) return true; return this.axis === 'x' ? r.right > edge : r.bottom > edge; };
    while (lo < hi) { const mid = (lo + hi) >> 1; if (past(mid)) hi = mid; else lo = mid + 1; }
    return { ch: +sec.dataset.ch, off: Math.min(lo, Math.max(0, map.total - 1)) };
  }
  next() {
    if (this.axis === 'x') this.sc.scrollTo({ left: Math.round(this.sc.scrollLeft / this.stride() + 1) * this.stride(), behavior: 'smooth' });
    else this.sc.scrollBy({ top: this.sc.clientHeight * 0.88, behavior: 'smooth' });
  }
  prev() {
    if (this.axis === 'x') this.sc.scrollTo({ left: Math.max(0, Math.round(this.sc.scrollLeft / this.stride() - 1)) * this.stride(), behavior: 'smooth' });
    else this.sc.scrollBy({ top: -this.sc.clientHeight * 0.88, behavior: 'smooth' });
  }
  refreshMarks(ch) {
    const el = this.secs.get(ch); if (!el) return;
    const pos = this.scrollPos;
    this.r.fill(el, ch);
    this.scrollPos = pos;
  }
  destroy() {
    this.sc?.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('keydown', this.onKey);
    clearTimeout(this.rt);
  }
}
