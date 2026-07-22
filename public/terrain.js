// Client-side elevation access. Tile fetch/cache stays plain JS — the
// browser's own fetch API and canvas-based PNG decode carry no real
// "coverage logic" drift risk, so reinventing them in Go/WebAssembly would
// only add binary size for no correctness benefit. The terrarium
// value-decode formula and the grid's bilinear lookup, however, now run
// through the shared Go/WebAssembly module (see wasm/main.go and
// wasm-bridge.js) — the same code internal/demgrid uses server-side —
// instead of a hand-ported, independently drifting JS copy.
//
// Works in both the main thread (loaded via <script>) and a Web Worker
// (loaded via importScripts): `self` is the global scope in both contexts,
// so everything hangs off that.
//
// Tiles are Mapzen/AWS "terrarium" PNGs (see internal/demgrid's comment for
// the format) fetched through nginx's same-origin /dem-tiles proxy
// (docker/default.conf) rather than the upstream host directly, so canvas
// pixel readback never risks a tainted-canvas / CORS failure.
(function () {
  const TILE_SIZE = 256;
  const MAX_CACHED_TILES = 400; // ~400 * 256*256*4 bytes ≈ 100MB worst case

  // "z/x/y" -> Uint8Array of TILE_SIZE*TILE_SIZE little-endian float32
  // elevation bytes (metres) — see decodeTerrariumBlob.
  const tileCache = new Map();

  function tileKey(z, x, y) {
    return `${z}/${x}/${y}`;
  }

  function lonToTileX(lon, z) {
    return ((lon + 180) / 360) * Math.pow(2, z);
  }

  function latToTileY(lat, z) {
    const latRad = (lat * Math.PI) / 180;
    return ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * Math.pow(2, z);
  }

  // Decodes a terrarium tile (already-fetched Blob) into little-endian
  // float32 elevation bytes (metres), TILE_SIZE*TILE_SIZE long. PNG
  // container decoding stays native (OffscreenCanvas, the browser's own
  // fast decoder); only the terrarium formula itself (R*256+G+B/256-32768)
  // runs through the shared Go/WebAssembly module, matching
  // internal/demgrid's terrariumFromImage exactly.
  async function decodeTerrariumBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE); // Uint8ClampedArray
    // decodeTerrarium expects a genuine Uint8Array (syscall/js.CopyBytesToGo
    // requires it) — this is a zero-copy view over the same bytes, not a
    // Uint8ClampedArray, which is a distinct type despite the identical
    // byte layout.
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    await self.__hopreachWasmReadyPromise;
    return self.__hopreachWasm.decodeTerrarium(rgba);
  }

  async function fetchTile(tileURLBase, z, x, y) {
    const key = tileKey(z, x, y);
    if (tileCache.has(key)) return tileCache.get(key);

    const url = `${tileURLBase}/${z}/${x}/${y}.png`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`tile fetch failed: ${url}: HTTP ${resp.status}`);
    const blob = await resp.blob();
    const elevBytes = await decodeTerrariumBlob(blob);

    if (tileCache.size >= MAX_CACHED_TILES) {
      const oldest = tileCache.keys().next().value;
      tileCache.delete(oldest);
    }
    tileCache.set(key, elevBytes);
    return elevBytes;
  }

  // Releases a grid's Go-side handle once the JS wrapper object returned by
  // buildLocalGrid is garbage-collected. Every call site already just lets
  // its grid reference fall out of scope when done with it (there was never
  // an explicit release/close in the pre-WASM JS-only LocalGrid either), so
  // automatic cleanup here needs no changes anywhere else.
  const gridRegistry = new FinalizationRegistry((handle) => {
    self.__hopreachWasm.releaseGrid(handle);
  });

  // buildLocalGrid fetches (and caches) every tile touching bounds
  // {south,north,west,east} at the given zoom, stitches their decoded
  // elevation bytes into one mosaic, and hands that to the WASM module to
  // build a Grid — returning a thin wrapper with a synchronous
  // .at(lat,lon), so the actual math loop (propagation search) stays
  // synchronous (no async re-entry mid-computation), same as before.
  async function buildLocalGrid(tileURLBase, zoom, bounds) {
    const minTileX = Math.floor(lonToTileX(bounds.west, zoom));
    const maxTileX = Math.floor(lonToTileX(bounds.east, zoom));
    const minTileY = Math.floor(latToTileY(bounds.north, zoom));
    const maxTileY = Math.floor(latToTileY(bounds.south, zoom));

    const tilesWide = maxTileX - minTileX + 1;
    const tilesHigh = maxTileY - minTileY + 1;
    const width = tilesWide * TILE_SIZE;
    const height = tilesHigh * TILE_SIZE;
    // Zero-initialized, same as a fresh Float32Array: IEEE754 zero is the
    // all-zero-bits pattern, so an untouched (missing-tile) region reads as
    // 0m elevation, matching demgrid.Load's graceful degradation for tiles
    // that fail to fetch (e.g. open ocean).
    const mosaic = new Uint8Array(width * height * 4);

    const jobs = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const ox = (tx - minTileX) * TILE_SIZE;
        const oy = (ty - minTileY) * TILE_SIZE;
        jobs.push(
          fetchTile(tileURLBase, zoom, tx, ty)
            .then((tileBytes) => {
              for (let row = 0; row < TILE_SIZE; row++) {
                const srcOff = row * TILE_SIZE * 4;
                const dstOff = ((oy + row) * width + ox) * 4;
                mosaic.set(tileBytes.subarray(srcOff, srcOff + TILE_SIZE * 4), dstOff);
              }
            })
            .catch((err) => {
              // Missing tile (e.g. open ocean) — leave as zero elevation,
              // same graceful-degradation approach as demgrid.Load.
              console.warn(err.message || err);
            })
        );
      }
    }
    await Promise.all(jobs);

    await self.__hopreachWasmReadyPromise;
    const handle = self.__hopreachWasm.createGrid(zoom, minTileX, minTileY, tilesWide, tilesHigh, mosaic);
    const grid = {
      __handle: handle,
      at(lat, lon) {
        return self.__hopreachWasm.gridAt(handle, lat, lon);
      },
    };
    gridRegistry.register(grid, handle);
    return grid;
  }

  self.Terrain = { buildLocalGrid, lonToTileX, latToTileY, TILE_SIZE };
})();
