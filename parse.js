// Pharos — book importers. Every reflowable format is normalised to:
// { meta:{title,author,format}, chapters:[{title,html,len}], toc:[{title,ch,off,level}], images:[Blob], cover:Blob|null }
import { readZip } from './zip.js';

const MAX_SECTION = 60000; // characters per internal section (keeps pagination fast)

export async function importFile(file) {
  const name = file.name || 'Untitled';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 5));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isPdf = String.fromCharCode(...head) === '%PDF-';
  let book;
  if (isPdf || ext === 'pdf') book = await parsePdf(buf, name);
  else if (ext === 'docx' || (isZip && ext !== 'epub' && await looksDocx(buf))) book = await parseDocx(buf, name);
  else if (isZip) book = await parseEpub(buf, name);
  else {
    const text = decodeText(buf);
    if (ext === 'md' || ext === 'markdown') book = parseMarkdown(text, name);
    else if (['html', 'htm', 'xhtml'].includes(ext) || /^\s*<(!doctype|html|\?xml)/i.test(text)) book = parseHtmlDoc(text, name);
    else book = parseText(text, name);
  }
  if (book.chapters) {
    book.chapters = book.chapters.filter(c => c.len > 0 || /<img/i.test(c.html));
    if (!book.chapters.length) throw new Error('No readable text found in this file');
    book.total = book.chapters.reduce((a, c) => a + c.len, 0);
  }
  return book;
}

async function looksDocx(buf) {
  try { return (await readZip(buf)).has('word/document.xml'); } catch { return false; }
}

function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(u8); }
}

const baseName = n => n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
const headText = el => { const c = el.cloneNode(true); c.querySelectorAll('br').forEach(b => b.replaceWith(' ')); return c.textContent.replace(/\s+/g, ' ').trim().slice(0, 90); };
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- HTML cleaning
const KEEP = new Set(['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'i', 'strong', 'b', 'u', 's', 'sub', 'sup', 'small', 'br', 'hr', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'img', 'a', 'figure', 'figcaption', 'cite', 'q', 'abbr', 'var', 'del', 'ins']);
const RENAME = { section: 'div', article: 'div', header: 'div', footer: 'div', aside: 'div', center: 'div', main: 'div', nav: 'div', big: 'span', font: 'span', tt: 'code', body: 'div', svg: null };
const DROP = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'audio', 'video', 'canvas', 'map', 'area']);

// ctx: { ch, resolveImg(src) -> index|null, resolveHref(href) -> "ch#id"|null }
function cleanInto(src, dst, ctx, inPre = false) {
  for (let n = src.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      let t = n.nodeValue;
      if (!inPre) t = t.replace(/[\s ]+/g, m => (m.includes(' ') ? ' ' : ' '));
      if (t) dst.appendChild(dst.ownerDocument.createTextNode(t));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const el = n;
    const tag = (el.localName || el.nodeName).toLowerCase();
    if (DROP.has(tag)) continue;
    const id = el.getAttribute('id');
    const cls = (el.getAttribute('class') || '');
    if (/^pg-(header|footer)/.test(id || '') || /pg-boilerplate|pgheader|pgfooter/.test(cls)) continue;
    if (tag === 'svg') { // cover pages often wrap <image> in svg
      const im = el.querySelector('image');
      if (im) {
        const href = im.getAttribute('xlink:href') || im.getAttribute('href');
        const idx = href != null ? ctx.resolveImg(href) : null;
        if (idx != null) { const i = dst.ownerDocument.createElement('img'); i.setAttribute('data-img', idx); i.className = 'cover-img'; dst.appendChild(i); }
      }
      continue;
    }
    let outTag = KEEP.has(tag) ? tag : (tag in RENAME ? RENAME[tag] : 'span');
    if (!outTag) continue;
    if (/^h[1-6]$/.test(tag)) outTag = tag;
    const out = dst.ownerDocument.createElement(outTag);
    if (id) out.id = `c${ctx.ch}-${id}`;
    const classes = cls.split(/\s+/).filter(Boolean).map(c => 'x-' + c.replace(/[^\w-]/g, ''));
    if (tag === 'center') classes.push('x-center');
    const style = el.getAttribute('style') || '';
    const ta = /text-align\s*:\s*(center|right)/i.exec(style) || (el.getAttribute('align') && [0, el.getAttribute('align').toLowerCase()]);
    if (ta && (ta[1] === 'center' || ta[1] === 'right')) classes.push('x-' + ta[1]);
    if (/font-variant\s*:\s*small-caps/i.test(style)) classes.push('x-smcap');
    if (/font-style\s*:\s*italic/i.test(style)) classes.push('x-italic');
    const ml = /margin-left\s*:\s*([\d.]+)em/i.exec(style);
    if (ml && +ml[1] > 0 && +ml[1] < 12) out.setAttribute('style', `margin-left:${(+ml[1]).toFixed(1)}em`);
    if (classes.length) out.className = classes.join(' ');
    if (tag === 'img') {
      const idx = ctx.resolveImg(el.getAttribute('src') || '');
      if (idx == null) continue;
      out.setAttribute('data-img', idx);
      const alt = el.getAttribute('alt'); if (alt) out.setAttribute('alt', alt);
      dst.appendChild(out); continue;
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href');
      if (href) {
        if (/^(https?|mailto):/i.test(href)) { out.setAttribute('href', href); out.setAttribute('target', '_blank'); out.setAttribute('rel', 'noopener'); }
        else { const r = ctx.resolveHref(href); if (r) out.setAttribute('data-href', r); }
      }
    }
    if (tag === 'td' || tag === 'th') { for (const a of ['colspan', 'rowspan']) if (el.getAttribute(a)) out.setAttribute(a, el.getAttribute(a)); }
    cleanInto(el, out, ctx, inPre || tag === 'pre');
    dst.appendChild(out);
  }
}

function textOffsetOf(root, target) {
  let off = 0;
  const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    if (target.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING || target.contains(t)) return off;
    off += t.nodeValue.length;
  }
  return off;
}

function trimEmpty(root) {
  // remove leading/trailing whitespace-only text & empty blocks created by stripping
  root.querySelectorAll('div,span,p').forEach(e => { if (!e.textContent.trim() && !e.querySelector('img,br,hr')) e.remove(); });
}

// Split a clean root element into sections at headings / by size
function splitSections(root, fallbackTitle) {
  const kids = [...root.childNodes];
  const levels = ['h1', 'h2', 'h3'];
  let splitLevel = null;
  for (const l of levels) { if (root.querySelectorAll(l).length >= 2) { splitLevel = l; break; } }
  const groups = [];
  let cur = null;
  const startGroup = title => { cur = { title, nodes: [] }; groups.push(cur); };
  for (const k of kids) {
    let h = null;
    if (splitLevel && k.nodeType === 1) h = k.matches(splitLevel) ? k : k.querySelector(splitLevel);
    if (h) {
      startGroup(headText(h) || fallbackTitle);
    } else if (!cur) startGroup(fallbackTitle);
    cur.nodes.push(k);
  }
  const out = [];
  for (const g of groups) {
    const box = root.ownerDocument.createElement('div');
    g.nodes.forEach(n => box.appendChild(n));
    sizeSplit(box).forEach((part, k) => out.push({ title: g.title, root: part, cont: k > 0 }));
  }
  return out;
}

function sizeSplit(box) {
  if (box.textContent.length <= MAX_SECTION * 1.3) return [box];
  const parts = [];
  let cur = box.ownerDocument.createElement('div'), n = 0;
  for (const k of [...box.childNodes]) {
    const len = k.textContent.length;
    if (n + len > MAX_SECTION && n > 0) { parts.push(cur); cur = box.ownerDocument.createElement('div'); n = 0; }
    cur.appendChild(k); n += len;
  }
  if (cur.childNodes.length) parts.push(cur);
  return parts;
}

function sectionsToBook(secs, meta, images = [], cover = null) {
  const chapters = [], toc = [];
  secs.forEach((s, i) => {
    const len = s.root.textContent.length;
    chapters.push({ title: s.title, html: s.root.innerHTML, len });
    if (!s.cont) toc.push({ title: s.title, ch: i, off: 0, level: 0 });
  });
  return { meta, chapters, toc, images, cover };
}

// ---------------------------------------------------------------- EPUB
async function parseEpub(buf, fileName) {
  const zip = await readZip(buf);
  const xml = (s, type = 'application/xml') => new DOMParser().parseFromString(s, type);
  const container = await zip.text('META-INF/container.xml');
  if (!container) throw new Error('EPUB is missing META-INF/container.xml');
  const opfPath = xml(container).querySelector('rootfile')?.getAttribute('full-path');
  const opf = xml(await zip.text(opfPath));
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const resolve = (base, rel) => {
    rel = decodeURIComponent(rel.split('#')[0]);
    if (!rel) return base;
    const parts = (base.slice(0, base.lastIndexOf('/') + 1) + rel).split('/');
    const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
    return out.join('/');
  };
  const tagText = sel => { const e = [...opf.getElementsByTagName('*')].find(x => x.localName === sel); return e ? e.textContent.trim() : ''; };
  const meta = { title: tagText('title') || baseName(fileName), author: tagText('creator'), format: 'epub' };

  const manifest = new Map();
  let coverHref = null, navHref = null, ncxHref = null;
  const coverId = [...opf.getElementsByTagName('*')].find(e => e.localName === 'meta' && e.getAttribute('name') === 'cover')?.getAttribute('content');
  for (const it of [...opf.getElementsByTagName('*')].filter(e => e.localName === 'item')) {
    const href = resolve(opfPath, it.getAttribute('href'));
    const item = { id: it.getAttribute('id'), href, type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
    manifest.set(item.id, item);
    if (/cover-image/.test(item.props) || (coverId && item.id === coverId)) coverHref = href;
    if (/\bnav\b/.test(item.props)) navHref = href;
    if (item.type === 'application/x-dtbncx+xml') ncxHref = href;
  }
  const spine = [...opf.getElementsByTagName('*')].filter(e => e.localName === 'itemref')
    .map(r => manifest.get(r.getAttribute('idref'))).filter(it => it && /html|xml/.test(it.type) && !/ncx/.test(it.type));
  const spineIndex = new Map(spine.map((s, i) => [s.href, i]));

  // images
  const images = [], imgIndex = new Map();
  async function imgFor(path) {
    if (imgIndex.has(path)) return imgIndex.get(path);
    const data = await zip.bytes(path);
    if (!data) { imgIndex.set(path, null); return null; }
    const type = [...manifest.values()].find(m => m.href === path)?.type || 'image/jpeg';
    images.push(new Blob([data], { type }));
    imgIndex.set(path, images.length - 1);
    return images.length - 1;
  }
  let cover = null;
  if (coverHref) { const d = await zip.bytes(coverHref); if (d) cover = new Blob([d], { type: manifest.get(coverId)?.type || 'image/jpeg' }); }

  // TOC (href -> title)
  const tocRaw = [];
  if (navHref) {
    const nav = xml(await zip.text(navHref), 'application/xhtml+xml');
    const tocNav = [...nav.getElementsByTagName('nav')].find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || nav.getElementsByTagName('nav')[0];
    const walk = (ol, level) => { for (const li of [...(ol?.children || [])]) { const a = li.querySelector('a'); if (a && a.getAttribute('href')) tocRaw.push({ title: a.textContent.replace(/\s+/g, ' ').trim(), href: a.getAttribute('href'), base: navHref, level }); const sub = [...li.children].find(c => c.localName === 'ol'); if (sub) walk(sub, level + 1); } };
    if (tocNav) walk([...tocNav.children].find(c => c.localName === 'ol'), 0);
  }
  if (!tocRaw.length && ncxHref) {
    const ncx = xml(await zip.text(ncxHref));
    const walk = (parent, level) => { for (const np of [...parent.children].filter(c => c.localName === 'navPoint')) { const label = [...np.getElementsByTagName('*')].find(e => e.localName === 'text'); const content = [...np.children].find(c => c.localName === 'content'); if (content) tocRaw.push({ title: (label?.textContent || '').replace(/\s+/g, ' ').trim(), href: content.getAttribute('src'), base: ncxHref, level }); walk(np, level + 1); } };
    const map = [...ncx.getElementsByTagName('*')].find(e => e.localName === 'navMap');
    if (map) walk(map, 0);
  }

  // Parse each spine document
  const secs = []; // {title, root, ch, srcHref}
  const docOut = document.implementation.createHTMLDocument('');
  for (let i = 0; i < spine.length; i++) {
    const it = spine[i];
    const src = await zip.text(it.href);
    if (!src) continue;
    let doc = xml(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    const body = doc.getElementsByTagName('body')[0];
    if (!body) continue;
    const imgQueue = [];
    const ctx = {
      ch: i,
      resolveImg: s => { const p = resolve(it.href, s); const key = '__img' + imgQueue.length; imgQueue.push(p); return key; },
      resolveHref: h => { if (h.startsWith('#')) return `${it.href}${h}`; return resolve(it.href, h) + (h.includes('#') ? '#' + h.split('#')[1] : ''); },
    };
    const root = docOut.createElement('div');
    cleanInto(body, root, ctx);
    // resolve image placeholders
    for (const im of root.querySelectorAll('img[data-img]')) {
      const k = im.getAttribute('data-img');
      const idx = await imgFor(imgQueue[+k.slice(5)]);
      if (idx == null) im.remove(); else im.setAttribute('data-img', idx);
    }
    trimEmpty(root);
    const text = root.textContent;
    if (/START: FULL LICENSE|THE FULL PROJECT GUTENBERG LICENSE/i.test(text) && text.length < 40000 && !root.querySelector('h1,h2,h3')?.textContent.match(/chapter/i)) continue;
    secs.push({ root, srcHref: it.href, spineIdx: i });
  }
  // sub-split oversized sections
  const finalSecs = [];
  for (const s of secs) {
    const parts = sizeSplit(s.root);
    parts.forEach((p, k) => finalSecs.push({ root: p, srcHref: s.srcHref, spineIdx: s.spineIdx, part: k }));
  }
  // map spine/href to final section index
  const firstSecOfHref = new Map();
  finalSecs.forEach((s, i) => { if (!firstSecOfHref.has(s.srcHref)) firstSecOfHref.set(s.srcHref, i); });
  const locate = (href, idPart) => {
    const first = firstSecOfHref.get(href);
    if (first == null) return null;
    if (!idPart) return { ch: first, off: 0 };
    const spineIdx = spineIndex.get(href);
    for (let i = first; i < finalSecs.length && finalSecs[i].srcHref === href; i++) {
      const el = finalSecs[i].root.querySelector(`[id="c${spineIdx}-${CSS.escape(idPart)}"]`);
      if (el) return { ch: i, off: textOffsetOf(finalSecs[i].root, el) };
    }
    return { ch: first, off: 0 };
  };
  // rewrite ids/links to final section indexes
  finalSecs.forEach((s, i) => {
    s.root.querySelectorAll('[data-href]').forEach(a => {
      const [h, frag] = a.getAttribute('data-href').split('#');
      const loc = locate(h, frag);
      if (loc) a.setAttribute('data-href', `${loc.ch}:${loc.off}`); else a.removeAttribute('data-href');
    });
  });
  const toc = [];
  for (const t of tocRaw) {
    const [h, frag] = t.href.split('#');
    const loc = locate(resolve(t.base, h), frag);
    if (loc && t.title) toc.push({ title: t.title, ch: loc.ch, off: loc.off, level: t.level });
  }
  // Drop Gutenberg boilerplate toc entries
  const cleanToc = toc.filter(t => !/project gutenberg|full license/i.test(t.title));
  const chapters = finalSecs.map((s, i) => {
    let title = [...cleanToc].reverse().find(t => t.ch < i || (t.ch === i && t.off === 0))?.title;
    const hh = s.root.querySelector('h1,h2,h3');
    if (!title) title = (hh && headText(hh)) || (i === 0 ? meta.title : `Section ${i + 1}`);
    return { title, html: s.root.innerHTML, len: s.root.textContent.length };
  });
  if (!cleanToc.length) chapters.forEach((c, i) => { if (!finalSecs[i].part) cleanToc.push({ title: c.title, ch: i, off: 0, level: 0 }); });
  return { meta, chapters, toc: cleanToc, images, cover };
}

// ---------------------------------------------------------------- Plain text (Gutenberg aware)
export function parseText(text, fileName) {
  text = text.replace(/\r\n?/g, '\n');
  const meta = { title: baseName(fileName), author: '', format: 'txt' };
  const t = /^Title:\s*(.+(?:\n {2,}.+)*)/m.exec(text.slice(0, 20000)); if (t) meta.title = t[1].replace(/\s+/g, ' ').trim();
  const a = /^Author:\s*(.+)/m.exec(text.slice(0, 20000)); if (a) meta.author = a[1].trim();
  const start = /^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG.*$/im.exec(text);
  if (start) text = text.slice(start.index + start[0].length);
  const end = /^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG.*$/im.exec(text);
  if (end) text = text.slice(0, end.index);
  else { const e2 = /^End of (the )?Project Gutenberg/im.exec(text); if (e2) text = text.slice(0, e2.index); }
  text = text.replace(/^\s*(Produced by|This eBook was produced by|E-text prepared by|Transcribed from)[\s\S]*?\n\n/i, '');

  const blocks = text.split(/\n[ \t]*\n/);
  const headRe = /^\s*((chapter|book|part|volume|act|scene|canto|stave|letter|section|prologue|epilogue|preface|introduction|conclusion|appendix)\b[^\n]{0,70}|[IVXLC]{1,7}\.?|\d{1,3}\.?)\s*$/i;
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  let headings = 0, prevWasHeading = false;
  for (const raw of blocks) {
    const lines = raw.split('\n').filter(l => l.trim().length);
    if (!lines.length) continue;
    const joined = lines.map(l => l.trim()).join(' ');
    if (lines.length <= 2 && headRe.test(lines[0]) && joined.length < 80) {
      if (prevWasHeading) { const h = root.lastChild; h.appendChild(doc.createElement('br')); h.appendChild(doc.createTextNode(joined)); continue; }
      const h = doc.createElement('h2'); h.textContent = joined; root.appendChild(h); headings++; prevWasHeading = true; continue;
    }
    // subtitle directly after heading (e.g. "CHAPTER I" / "THE PERIOD")
    if (prevWasHeading && lines.length === 1 && joined.length < 70 && joined === joined.toUpperCase() && /[A-Z]/.test(joined)) {
      const h = root.lastChild; h.appendChild(doc.createElement('br')); h.appendChild(doc.createTextNode(joined)); continue;
    }
    prevWasHeading = false;
    const maxLen = Math.max(...lines.map(l => l.length));
    const indented = lines.every(l => /^\s{2,}/.test(l));
    if (lines.length >= 2 && (maxLen < 55 || indented)) { // verse / letters: keep line breaks
      const p = doc.createElement('p'); p.className = 'x-verse';
      lines.forEach((l, i) => { if (i) p.appendChild(doc.createElement('br')); p.appendChild(doc.createTextNode(l.replace(/\s+$/, '').replace(/^\s+/, m => ' '.repeat(Math.min(m.length, 12))))); });
      root.appendChild(p);
    } else if (lines.length === 1 && ((joined.length < 60 && joined === joined.toUpperCase() && /[A-Z]{3}/.test(joined)) || /^by\s.{2,40}$/i.test(joined))) {
      const p = doc.createElement('p'); p.className = 'x-center x-smcap'; p.textContent = joined; root.appendChild(p);
    } else {
      const p = doc.createElement('p');
      p.textContent = joined.replace(/_([^_]+)_/g, '\u0001$1\u0002');
      if (p.textContent.includes('\u0001')) p.innerHTML = esc(joined).replace(/_([^_]+)_/g, '<em>$1</em>');
      root.appendChild(p);
    }
  }
  const secs = headings >= 2 ? splitSections(root, meta.title) : sizeSplit(root).map((r, i) => ({ title: i ? `${meta.title} (${i + 1})` : meta.title, root: r }));
  return sectionsToBook(secs, meta);
}

// ---------------------------------------------------------------- Markdown
function parseMarkdown(md, fileName) {
  md = md.replace(/\r\n?/g, '\n');
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '<strong>$1$2</strong>').replace(/\*([^*]+)\*|_([^_]+)_/g, '<em>$1$2</em>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  const blocks = md.split(/\n\s*\n/);
  for (const b of blocks) {
    const h = /^(#{1,6})\s+(.*)$/.exec(b.trim());
    if (h && !b.trim().includes('\n')) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^```/.test(b.trim())) { out.push(`<pre>${esc(b.trim().replace(/^```\w*\n?|```$/g, ''))}</pre>`); continue; }
    if (/^\s*([-*+]|\d+\.)\s/.test(b)) { const ordered = /^\s*\d+\./.test(b); const items = b.split(/\n(?=\s*([-*+]|\d+\.)\s)/).filter(x => x && !/^([-*+]|\d+\.)$/.test(x.trim())); out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(i => `<li>${inline(i.replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/\n/g, ' '))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue; }
    if (/^>/.test(b.trim())) { out.push(`<blockquote><p>${inline(b.replace(/^\s*>\s?/gm, '').replace(/\n/g, ' '))}</p></blockquote>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(b.trim())) { out.push('<hr>'); continue; }
    const lines = b.split('\n');
    const hm = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (hm) { out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); lines.shift(); }
    if (lines.join('').trim()) out.push(`<p>${lines.map(inline).join(' ')}</p>`);
  }
  const firstH1 = /^#\s+(.+)$/m.exec(md);
  const book = parseHtmlDoc(`<head><title>${esc(firstH1 ? firstH1[1].trim() : baseName(fileName))}</title></head><body>${out.join('\n')}</body>`, fileName);
  book.meta.format = 'md';
  return book;
}

// ---------------------------------------------------------------- HTML document
function parseHtmlDoc(html, fileName) {
  const src = new DOMParser().parseFromString(html, 'text/html');
  const meta = { title: src.title?.trim() || baseName(fileName), author: src.querySelector('meta[name="author"]')?.content || '', format: 'html' };
  const m = /^(.*?),?\s+by\s+(.+)$/i.exec(meta.title.replace(/^The Project Gutenberg e?Book of\s+/i, ''));
  if (m && /gutenberg/i.test(meta.title)) { meta.title = m[1]; meta.author = meta.author || m[2]; }
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  cleanInto(src.body, root, { ch: 0, resolveImg: () => null, resolveHref: () => null });
  trimEmpty(root);
  // flatten single wrapper divs so headings are top-level
  while (root.childElementCount === 1 && root.firstElementChild.tagName === 'DIV' && !root.textContent.replace(root.firstElementChild.textContent, '').trim()) {
    const w = root.firstElementChild; while (w.firstChild) root.insertBefore(w.firstChild, w); w.remove();
  }
  return sectionsToBook(splitSections(root, meta.title), meta);
}

// ---------------------------------------------------------------- DOCX
async function parseDocx(buf, fileName) {
  const zip = await readZip(buf);
  const x = s => new DOMParser().parseFromString(s, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const docXml = x(await zip.text('word/document.xml'));
  const core = zip.has('docProps/core.xml') ? x(await zip.text('docProps/core.xml')) : null;
  const meta = { title: core?.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent || baseName(fileName), author: core?.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]?.textContent || '', format: 'docx' };
  const rels = new Map();
  if (zip.has('word/_rels/document.xml.rels')) for (const r of x(await zip.text('word/_rels/document.xml.rels')).getElementsByTagName('Relationship')) rels.set(r.getAttribute('Id'), r.getAttribute('Target'));
  // style id -> name for headings
  const styleNames = new Map();
  if (zip.has('word/styles.xml')) for (const s of x(await zip.text('word/styles.xml')).getElementsByTagNameNS(W, 'style')) { const n = s.getElementsByTagNameNS(W, 'name')[0]; if (n) styleNames.set(s.getAttributeNS(W, 'styleId'), n.getAttributeNS(W, 'val').toLowerCase()); }
  const images = [], imgMap = new Map();
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  const val = (el, tag) => { const e = el?.getElementsByTagNameNS(W, tag)[0]; return e ? (e.getAttributeNS(W, 'val') ?? 'true') : null; };
  const body = docXml.getElementsByTagNameNS(W, 'body')[0];
  async function para(p) {
    const pPr = p.getElementsByTagNameNS(W, 'pPr')[0];
    const sid = val(pPr, 'pStyle') || '';
    const sname = styleNames.get(sid) || sid.toLowerCase();
    let tag = 'p';
    const hm = /^(heading|überschrift|titre)\s*(\d)/.exec(sname) || /^heading(\d)$/.exec(sid.toLowerCase());
    if (sname === 'title') tag = 'h1'; else if (hm) tag = 'h' + Math.min(6, +(hm[2] || hm[1]) + (sname === 'title' ? 0 : 1)); else if (/quote/.test(sname)) tag = 'blockquote';
    const el = doc.createElement(tag);
    const jc = val(pPr, 'jc'); if (jc === 'center' || jc === 'right') el.className = 'x-' + jc;
    for (const r of p.childNodes) {
      if (r.nodeType !== 1) continue;
      const runs = r.localName === 'r' ? [r] : r.localName === 'hyperlink' || r.localName === 'ins' || r.localName === 'smartTag' ? [...r.getElementsByTagNameNS(W, 'r')] : [];
      for (const run of runs) {
        const rPr = run.getElementsByTagNameNS(W, 'rPr')[0];
        let target = el;
        const wrap = t => { const e = doc.createElement(t); target.appendChild(e); target = e; };
        if (rPr) { if (val(rPr, 'b') && val(rPr, 'b') !== '0' && val(rPr, 'b') !== 'false') wrap('strong'); if (val(rPr, 'i') && val(rPr, 'i') !== '0' && val(rPr, 'i') !== 'false') wrap('em'); if (val(rPr, 'u') && val(rPr, 'u') !== 'none') wrap('u'); if (val(rPr, 'smallCaps')) { wrap('span'); target.className = 'x-smcap'; } const va = val(rPr, 'vertAlign'); if (va === 'superscript') wrap('sup'); if (va === 'subscript') wrap('sub'); }
        for (const c of run.childNodes) {
          if (c.localName === 't') target.appendChild(doc.createTextNode(c.textContent));
          else if (c.localName === 'tab') target.appendChild(doc.createTextNode(' '));
          else if (c.localName === 'br' || c.localName === 'cr') target.appendChild(doc.createElement('br'));
          else if (c.localName === 'drawing' || c.localName === 'pict') {
            const blip = c.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0];
            const rid = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
            const t = rid && rels.get(rid);
            if (t) {
              const path = 'word/' + t.replace(/^\/?word\//, '');
              if (!imgMap.has(path)) { const d = await zip.bytes(path); if (d) { const ext = path.split('.').pop().toLowerCase(); images.push(new Blob([d], { type: ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg' })); imgMap.set(path, images.length - 1); } }
              if (imgMap.has(path)) { const im = doc.createElement('img'); im.setAttribute('data-img', imgMap.get(path)); target.appendChild(im); }
            }
          }
        }
      }
    }
    return el;
  }
  for (const n of body.childNodes) {
    if (n.localName === 'p') { const el = await para(n); if (el.textContent.trim() || el.querySelector('img')) root.appendChild(el); }
    else if (n.localName === 'tbl') {
      const t = doc.createElement('table');
      for (const tr of n.getElementsByTagNameNS(W, 'tr')) { const r = doc.createElement('tr'); for (const tc of tr.getElementsByTagNameNS(W, 'tc')) { const td = doc.createElement('td'); for (const p of tc.getElementsByTagNameNS(W, 'p')) td.appendChild(await para(p)); r.appendChild(td); } t.appendChild(r); }
      root.appendChild(t);
    }
  }
  const book = sectionsToBook(splitSections(root, meta.title), meta, images);
  return book;
}

// ---------------------------------------------------------------- PDF (fixed layout; stored raw)
async function parsePdf(buf, fileName) {
  const { loadPdf } = await import('./pdfview.js');
  const pdf = await loadPdf(buf.slice(0));
  let meta = { title: baseName(fileName), author: '', format: 'pdf' };
  try { const info = (await pdf.getMetadata()).info || {}; if (info.Title && info.Title.trim().length > 2) meta.title = info.Title.trim(); if (info.Author) meta.author = info.Author.trim(); } catch {}
  let toc = [];
  try {
    const outline = await pdf.getOutline();
    const walk = async (items, level) => { for (const it of items || []) { try { let dest = it.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest); if (dest) { const page = await pdf.getPageIndex(dest[0]); toc.push({ title: it.title, ch: page, off: 0, level }); } } catch {} if (level < 2) await walk(it.items, level + 1); } };
    await walk(outline, 0);
  } catch {}
  // cover thumbnail
  let cover = null;
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 360 / vp.width;
    const c = document.createElement('canvas'); const v2 = page.getViewport({ scale });
    c.width = v2.width; c.height = v2.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
    cover = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  } catch {}
  const pages = pdf.numPages;
  pdf.destroy();
  return { meta, pdf: new Blob([buf], { type: 'application/pdf' }), pages, toc, cover, total: pages };
}
