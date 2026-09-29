// Pharos service worker — makes the app work fully offline after the first visit.
const VERSION = 'pharos-v1';
const FONT_CACHE = 'pharos-fonts';
const SHARE_CACHE = 'pharos-share';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './pharos.css',
  './app.js', './db.js', './parse.js', './reader.js', './textmap.js', './zip.js', './pdfview.js',
  './Lora.woff', './Lora-Italic.woff',
  './icon-192.png', './icon-512.png', './maskable-512.png',
  './pdf.min.mjs', './pdf.worker.min.mjs',
  './FoxitDingbats.pfb', './FoxitFixed.pfb', './FoxitFixedBold.pfb', './FoxitFixedBoldItalic.pfb', './FoxitFixedItalic.pfb', './FoxitSerif.pfb', './FoxitSerifBold.pfb', './FoxitSerifBoldItalic.pfb', './FoxitSerifItalic.pfb', './FoxitSymbol.pfb', './LiberationSans-Bold.ttf', './LiberationSans-BoldItalic.ttf', './LiberationSans-Italic.ttf', './LiberationSans-Regular.ttf', './jbig2.wasm', './openjpeg.wasm', './qcms_bg.wasm',
];
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=IM+Fell+DW+Pica:ital@0;1&family=IM+Fell+English:ital@0;1&family=UnifrakturMaguntia&display=swap';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    // Period fonts: fetch the stylesheet and every font file it references, so they work offline.
    try {
      const fc = await caches.open(FONT_CACHE);
      const res = await fetch(FONTS_CSS, { mode: 'cors' });
      if (res.ok) {
        const css = await res.clone().text();
        await fc.put(FONTS_CSS, res);
        const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
        await Promise.all(urls.map(u => fetch(u, { mode: 'cors' }).then(r => r.ok && fc.put(u, r)).catch(() => {})));
      }
    } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![VERSION, FONT_CACHE, SHARE_CACHE].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Android "Share → Pharos": receive the file, park it, then open the app which imports it.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await req.formData();
      const c = await caches.open(SHARE_CACHE);
      for (const f of form.getAll('book')) {
        if (f && f.name) await c.put(new Request('./shared/' + Date.now() + '/' + encodeURIComponent(f.name)), new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
      }
      const all = await self.clients.matchAll({ type: 'window' });
      all.forEach(cl => cl.postMessage('shared'));
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const c = await caches.open(FONT_CACHE);
      const hit = await c.match(req, { ignoreVary: true }) || await c.match(req.url);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }
      catch { return new Response('', { status: 504 }); }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r.ok && req.mode !== 'navigate') c.put(req, r.clone()); if (r.ok && req.mode === 'navigate') c.put('./index.html', r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Offline', { status: 503 });
  })());
});
