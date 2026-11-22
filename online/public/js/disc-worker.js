// Disc prefetcher. The game reads the disc in 256 KB chunks with a blocking
// request from its emulation thread: a chunk that is not in the browser's HTTP
// cache stalls the game for a network round trip. This worker fills that cache
// ahead of the game:
//   1. while players gather in the lobby: the chunks the server saw games need
//      first (boot, menus, battles — /disc/hot.json, in order of first use);
//   2. during the game: read-ahead after every chunk the game fetches (the
//      emulation thread announces them on the 'cdg-disc' BroadcastChannel).
// Chunk URLs are immutable, so the game's own request then hits the cache.
const AHEAD = 12;          // chunks read ahead of the game's position (3 MB)
const PARALLEL = 3;
const done = new Set();    // URLs already in the cache (or being fetched)
const urgent = [];         // read-ahead, most recent position first
const background = [];     // hot list
let running = 0;
let tracks = [];           // chunk counts per track
const cached = new Set();  // URLs now in the browser cache
let hotUrls = [];          // the preload list
// Progress of the preload list, for the page (lobby: "preloading 40%").
let reported = -1;
function report() {
  if (!hotUrls.length) return;
  let n = 0;
  for (const u of hotUrls) if (cached.has(u)) n++;
  if (n === reported) return;
  reported = n;
  postMessage({ t: 'progress', done: n, total: hotUrls.length, chunk: chunkBytes });
}
let chunkBytes = 262144;

function want(url, front) {
  if (done.has(url)) return;
  if (front) urgent.push(url); else background.push(url);
  pump();
}

function next() {
  while (urgent.length) { const u = urgent.shift(); if (!done.has(u)) return u; }
  while (background.length) { const u = background.shift(); if (!done.has(u)) return u; }
  return null;
}

function pump() {
  while (running < PARALLEL) {
    const url = next();
    if (!url) return;
    done.add(url);
    running++;
    fetch(url, { headers: { 'x-cdg-prefetch': '1' } }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then(() => { cached.add(url); report(); })
      .catch(() => done.delete(url))
      .finally(() => { running--; pump(); });
  }
}

const bc = new BroadcastChannel('cdg-disc');
bc.onmessage = (e) => {
  // "/disc/<track>/<chunk>" fetched by the game: read ahead of it.
  const m = /^\/disc\/(\d+)\/(\d+)$/.exec(String(e.data));
  if (!m) return;
  const t = +m[1], i = +m[2];
  done.add(e.data);
  cached.add(e.data);
  report();
  const n = tracks[t] ?? Infinity;
  // Newest position first: drop read-ahead queued for older positions.
  urgent.length = 0;
  for (let k = 1; k <= AHEAD && i + k < n; k++) want(`/disc/${t}/${i + k}`, true);
};

(async () => {
  try {
    const hot = await (await fetch('/disc/hot.json', { cache: 'no-store' })).json();
    tracks = hot.tracks || [];
    chunkBytes = hot.chunk || chunkBytes;
    hotUrls = (hot.chunks || []).map(([t, i]) => `/disc/${t}/${i}`);
    for (const u of hotUrls) want(u, false);
    if (!hotUrls.length) postMessage({ t: 'progress', done: 0, total: 0, chunk: chunkBytes });
    report();
  } catch { /* no list yet: read-ahead only */ }
})();
