// Pharos — character-offset <-> DOM mapping. Positions and highlights are stored as
// (section, character offset in textContent), which survives any re-layout.

export function textNodes(root) {
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) { out.push({ node: n, start: pos }); pos += n.nodeValue.length; }
  out.total = pos;
  return out;
}

export function locate(map, off) {
  if (!map.length) return null;
  off = Math.max(0, Math.min(off, map.total - 1));
  let lo = 0, hi = map.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (map[mid].start <= off) lo = mid; else hi = mid - 1; }
  const e = map[lo];
  return { node: e.node, offset: Math.min(off - e.start, Math.max(0, e.node.nodeValue.length - 1)) };
}

export function offsetOf(root, node, offset) {
  if (node.nodeType !== 3) {
    // element boundary: count text before child index
    const r = document.createRange();
    r.setStart(root, 0);
    try { r.setEnd(node, offset); } catch { return 0; }
    return r.toString().length;
  }
  let pos = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n === node) return pos + offset; pos += n.nodeValue.length; }
  return pos;
}

// Rect of the character at `off` (skips collapsed whitespace)
export function charRect(map, off, dirForward = true) {
  const r = document.createRange();
  for (let k = 0; k < 60; k++) {
    const o = dirForward ? off + k : off - k;
    if (o < 0 || o >= map.total) break;
    const loc = locate(map, o);
    if (!loc) break;
    r.setStart(loc.node, loc.offset);
    r.setEnd(loc.node, Math.min(loc.offset + 1, loc.node.nodeValue.length));
    const rects = r.getClientRects();
    if (rects.length && rects[0].width + rects[0].height > 0) return rects[0];
  }
  // fallback: parent element box
  const loc = locate(map, off);
  return loc ? loc.node.parentElement.getBoundingClientRect() : null;
}

// Wrap [start,end) in elements produced by make(); returns created elements
export function wrapRange(root, start, end, make) {
  const created = [];
  if (end <= start) return created;
  const map = textNodes(root);
  for (const { node, start: s } of map) {
    const e = s + node.nodeValue.length;
    if (e <= start || s >= end) continue;
    if (!node.nodeValue.trim() && node.parentElement && /^(TABLE|TBODY|TR|UL|OL)$/.test(node.parentElement.tagName)) continue;
    let n = node;
    const a = Math.max(0, start - s), b = Math.min(n.nodeValue.length, end - s);
    if (b < n.nodeValue.length) n.splitText(b);
    if (a > 0) n = n.splitText(a);
    const el = make();
    n.parentNode.insertBefore(el, n);
    el.appendChild(n);
    created.push(el);
  }
  return created;
}

export function unwrap(els) {
  for (const el of els) {
    const p = el.parentNode; if (!p) continue;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el); p.normalize();
  }
}
