// Pharos — basic fixed-layout PDF support (vertical page scroll, lazy rendering).
let lib = null;
async function pdfjs() {
  if (lib) return lib;
  lib = await import('./pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
  return lib;
}
export async function loadPdf(data) {
  const p = await pdfjs();
  return p.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: new URL('./', import.meta.url).href,
    wasmUrl: new URL('./', import.meta.url).href,
    isEvalSupported: false,
  }).promise;
}

export class PdfReader {
  constructor(host, blob, opts) {
    this.host = host; this.blob = blob; this.opts = opts; // opts: {onPosition, onTap, startPage}
    this.el = document.createElement('div');
    this.el.className = 'pdf-scroll';
    host.appendChild(this.el);
    this.rendered = new Map();
  }
  async init() {
    this.doc = await loadPdf(await this.blob.arrayBuffer());
    this.pages = this.doc.numPages;
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.ratio = vp.height / vp.width;
    const w = this.el.clientWidth - 16;
    for (let i = 0; i < this.pages; i++) {
      const d = document.createElement('div');
      d.className = 'pdf-page'; d.dataset.page = i;
      d.style.height = Math.round(w * this.ratio) + 'px';
      this.el.appendChild(d);
    }
    this.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) this.renderPage(+e.target.dataset.page); }), { root: this.el, rootMargin: '150% 0px' });
    this.el.querySelectorAll('.pdf-page').forEach(p => this.io.observe(p));
    this.el.addEventListener('scroll', () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.report()); });
    let down = null;
    this.el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
    this.el.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || Date.now() - down.t > 400) return;
      const h = this.el.clientHeight, y = e.clientY - this.el.getBoundingClientRect().top;
      if (y < h * 0.25) this.el.scrollBy({ top: -h * 0.85, behavior: 'smooth' });
      else if (y > h * 0.75) this.el.scrollBy({ top: h * 0.85, behavior: 'smooth' });
      else this.opts.onTap('center');
    });
    this.goTo({ ch: this.opts.startPage || 0, off: 0 });
  }
  async renderPage(i) {
    if (this.rendered.has(i)) return;
    this.rendered.set(i, true);
    const page = await this.doc.getPage(i + 1);
    const box = this.el.children[i];
    const cssW = box.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = page.getViewport({ scale: 1 });
    const v = page.getViewport({ scale: cssW / vp.width * dpr });
    const c = document.createElement('canvas');
    c.width = v.width; c.height = v.height;
    c.style.width = '100%'; c.style.height = '100%';
    box.style.height = Math.round(cssW * vp.height / vp.width) + 'px';
    box.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
  }
  current() {
    const top = this.el.scrollTop + 4;
    let lo = 0, hi = this.pages - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.el.children[m].offsetTop <= top) lo = m; else hi = m - 1; }
    return lo;
  }
  report() { const p = this.current(); this.opts.onPosition({ ch: p, off: 0 }, (p + 1) / this.pages, `Page ${p + 1} of ${this.pages}`); }
  goTo(pos) { const el = this.el.children[Math.max(0, Math.min(this.pages - 1, pos.ch))]; if (el) this.el.scrollTop = el.offsetTop - 8; this.report(); }
  goToFraction(f) { this.goTo({ ch: Math.round(f * (this.pages - 1)) }); }
  getPos() { return { ch: this.current(), off: 0 }; }
  destroy() { this.io?.disconnect(); this.doc?.destroy(); this.el.remove(); }
}
