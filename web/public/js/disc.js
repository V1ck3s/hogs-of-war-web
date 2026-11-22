// Disc selection: CUE/BIN sets, single BIN/ISO, CHD, PBP-less raw images,
// and ZIP archives (stored or deflated entries, decompressed in a stream).

const DISC_EXT = /\.(cue|bin|img|iso|chd|sbi|ccd|sub|m3u)$/i;

/** Read a ZIP's central directory and return entries as lazily-inflated Blobs. */
export async function unzip(file, onProgress) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Unreadable ZIP archive.');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // ZIP64 end-of-central-directory locator
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
      const z64off = Number(tail.getBigUint64(loc + 8, true));
      const z = new DataView(await file.slice(z64off, z64off + 56).arrayBuffer());
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOff = Number(z.getBigUint64(48, true));
    }
  }
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let usize = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true);
    const xlen = cd.getUint16(p + 30, true);
    const clen = cd.getUint16(p + 32, true);
    let loff = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, p + 46, nlen));
    // ZIP64 extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (loff === 0xffffffff) { loff = Number(cd.getBigUint64(q, true)); q += 8; }
      }
      x += 4 + len;
    }
    entries.push({ name, method, csize, usize, loff });
    p += 46 + nlen + xlen + clen;
  }
  const out = [];
  let done = 0;
  const total = entries.reduce((a, e) => a + (DISC_EXT.test(e.name) ? e.usize : 0), 0);
  for (const e of entries) {
    const base = e.name.split('/').pop();
    if (!base || !DISC_EXT.test(base)) continue;
    const lh = new DataView(await file.slice(e.loff, e.loff + 30).arrayBuffer());
    const dataOff = e.loff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = file.slice(dataOff, dataOff + e.csize);
    let blob;
    if (e.method === 0) blob = raw;
    else if (e.method === 8) {
      // Collect the inflated stream as 8 MB Blob pieces: the browser can page
      // those to disk, unlike one huge in-memory buffer.
      const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const pieces = [];
      let chunk = [], chunkLen = 0, seen = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (value) {
          chunk.push(value); chunkLen += value.length; seen += value.length;
          if (chunkLen >= 8 << 20) { pieces.push(new Blob(chunk)); chunk = []; chunkLen = 0; }
          if (onProgress) onProgress((done + seen) / total);
        }
        if (end) break;
      }
      if (chunkLen) pieces.push(new Blob(chunk));
      blob = new Blob(pieces);
      if (blob.size !== e.usize) throw new Error(`Corrupt archive (${base}).`);
    } else throw new Error(`Unsupported ZIP compression method ${e.method}.`);
    done += e.usize;
    out.push(new File([blob], base));
  }
  return out;
}

async function isZip(f) {
  if (DISC_EXT.test(f.name) || f.size < 22) return false;
  const b = new Uint8Array(await f.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** Normalise a user selection into { files: [{name, file}], entry } */
export async function prepareDisc(fileList, onProgress) {
  let files = [];
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name) || await isZip(f)) files.push(...(await unzip(f, onProgress)));
    else if (DISC_EXT.test(f.name)) files.push(f);
  }
  if (!files.length) throw new Error('No recognised disc file (.cue/.bin, .chd, .iso or .zip).');
  const byName = new Map(files.map((f) => [f.name, f]));
  const cue = files.find((f) => /\.cue$/i.test(f.name));
  let entry;
  if (cue) {
    const text = await cue.text();
    const refs = [...text.matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => m[1]);
    const missing = refs.filter((r) => !byName.has(r.split(/[\\/]/).pop()));
    if (missing.length) throw new Error('Files missing for the CUE: ' + missing.join(', '));
    entry = cue.name;
    // SBI companion must share the CUE basename for the core to find it.
    const sbi = files.find((f) => /\.sbi$/i.test(f.name));
    if (sbi) {
      const want = cue.name.replace(/\.cue$/i, '.sbi');
      if (sbi.name !== want) files = files.filter((f) => f !== sbi).concat(new File([sbi], want));
    }
  } else {
    const main = files.find((f) => /\.(chd|iso|img|bin)$/i.test(f.name));
    if (!main) throw new Error('Disc image not found.');
    entry = main.name;
  }
  return { files: files.map((f) => ({ name: f.name, file: f })), entry };
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Disc fingerprint for netplay: sizes of all data/audio files plus hashes of
 * samples of the main track. Peers must have bit-identical discs to stay in
 * lockstep; file names may differ.
 */
export async function fingerprint({ files, entry }) {
  const tracks = files.filter((f) => !/\.(cue|sbi|m3u)$/i.test(f.name)).map((f) => f.file);
  tracks.sort((a, b) => b.size - a.size);
  const main = tracks[0];
  const parts = [];
  const SAMPLE = 1 << 20;
  for (const off of [0, Math.floor(main.size / 2), Math.max(0, main.size - SAMPLE)]) {
    parts.push(new Uint8Array(await main.slice(off, off + SAMPLE).arrayBuffer()));
  }
  const sizes = tracks.map((t) => t.size).join(',');
  const enc = new TextEncoder().encode(sizes + '|' + entry.split('.').pop().toLowerCase());
  const total = parts.reduce((a, p) => a + p.length, enc.length);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of [enc, ...parts]) { all.set(p, o); o += p.length; }
  return (await sha256Hex(all)).slice(0, 32);
}
