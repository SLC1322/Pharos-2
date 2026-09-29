// Pharos — minimal ZIP reader (EPUB, DOCX) using the browser's native DecompressionStream.

export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // Find End Of Central Directory record (scan backwards, max comment 64 KB)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP/EPUB file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nlen = view.getUint16(p + 28, true);
    const elen = view.getUint16(p + 30, true);
    const clen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { name, method, csize, usize, local });
    p += 46 + nlen + elen + clen;
  }

  async function data(name) {
    const e = entries.get(name) || findCI(name);
    if (!e) return null;
    const lp = e.local;
    const nlen = view.getUint16(lp + 26, true);
    const elen = view.getUint16(lp + 28, true);
    const start = lp + 30 + nlen + elen;
    const raw = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return raw.slice();
    if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const out = new Blob([raw]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(out).arrayBuffer());
    }
    throw new Error('Unsupported ZIP compression method ' + e.method);
  }
  function findCI(name) {
    const lower = name.toLowerCase();
    for (const [k, v] of entries) if (k.toLowerCase() === lower) return v;
    return null;
  }
  return {
    names: [...entries.keys()],
    has: n => entries.has(n) || !!findCI(n),
    bytes: data,
    async text(name) { const d = await data(name); return d ? dec.decode(d) : null; },
  };
}
