//go:build js && wasm

// Command wasm compiles internal/propagation and internal/demgrid — the
// same code the backend trusts — to WebAssembly, so the browser-side
// planning tools (public/*.js) share one implementation of the coverage
// physics and terrain lookup instead of a hand-ported, independently
// drifting JS copy. Tile fetching/caching (browser fetch + canvas PNG
// decode) stays in JS — the DOM/network APIs involved have no Go
// equivalent worth reinventing, and that part carries no real drift risk
// (a plain file fetch, not domain logic). Only the parts that actually
// encode this project's terrain/RF model cross into Go: the terrarium
// tile decode formula, the bilinear grid lookup, and the propagation math
// itself.
//
// Exposes a small, deliberately low-level API on
// globalThis.__hopreachWasm — see public/wasm-bridge.js for the
// JS-friendly Propagation/Terrain wrapper every other frontend script
// actually calls, matching the shape the pre-WASM propagation.js/
// terrain.js exposed so call sites elsewhere needed no changes.
package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"sync"
	"syscall/js"

	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
)

// tileSize is the Mapzen/AWS terrarium tile format's fixed dimension —
// external spec constant (see internal/demgrid's package doc), not
// project-specific logic, so duplicating this one number here doesn't
// carry the drift risk this package exists to eliminate.
const tileSize = 256

// Handles: JS holds an opaque integer for a Go-side Params/Grid rather
// than a real pointer/reference, since syscall/js has no safe way to hand
// a Go pointer to JS and get it back later across the GC boundary — a
// small registry keyed by a sequence number is the standard, robust
// pattern instead.
var (
	mu         sync.Mutex
	nextHandle int
	paramsReg  = map[int]propagation.Params{}
	gridReg    = map[int]*demgrid.Grid{}
)

func newHandle() int {
	mu.Lock()
	defer mu.Unlock()
	nextHandle++
	return nextHandle
}

func getFloat(v js.Value, key string) float64 {
	return v.Get(key).Float()
}

func paramsFromJS(v js.Value) propagation.Params {
	return propagation.Params{
		FrequencyMHz:    getFloat(v, "frequencyMhz"),
		TxPowerDBm:      getFloat(v, "txPowerDbm"),
		TxAntennaGainDB: getFloat(v, "txAntennaGainDbi"),
		RxAntennaGainDB: getFloat(v, "rxAntennaGainDbi"),
		RxSensitivityDB: getFloat(v, "rxSensitivityDbm"),
		FadeMarginDB:    getFloat(v, "fadeMarginDb"),
		AntennaHeightM:  getFloat(v, "antennaHeightM"),
		RxHeightM:       getFloat(v, "rxHeightM"),
		MaxRangeKm:      getFloat(v, "maxRangeKm"),
		MarginGreenDB:   getFloat(v, "marginGreenDb"),
	}
}

// jsCreateParams(paramsObj) -> handle. Converts a propagation-params JS
// object into a registry entry once, so the hot-path pathMargin/
// linkBudgetMaxRangeKm calls only ever need a cheap integer lookup instead
// of re-reading 10 object properties across the JS/Wasm boundary every call.
func jsCreateParams(this js.Value, args []js.Value) any {
	h := newHandle()
	p := paramsFromJS(args[0])
	mu.Lock()
	paramsReg[h] = p
	mu.Unlock()
	return h
}

func jsReleaseParams(this js.Value, args []js.Value) any {
	h := args[0].Int()
	mu.Lock()
	delete(paramsReg, h)
	mu.Unlock()
	return nil
}

func jsHaversineKm(this js.Value, args []js.Value) any {
	lat1, lon1, lat2, lon2 := args[0].Float(), args[1].Float(), args[2].Float(), args[3].Float()
	return propagation.HaversineKm(lat1, lon1, lat2, lon2)
}

func jsLinkBudgetMaxRangeKm(this js.Value, args []js.Value) any {
	mu.Lock()
	p := paramsReg[args[0].Int()]
	mu.Unlock()
	return propagation.LinkBudgetMaxRangeKm(p)
}

// jsDecodeTerrarium(rgbaBytes) -> Uint8Array of tileSize*tileSize
// little-endian float32 elevations (metres) — the same terrarium formula
// as internal/demgrid's terrariumFromImage, applied to the already-decoded
// RGBA pixel bytes a <canvas> gave the caller (see public/wasm-bridge.js:
// PNG container decoding itself stays native/JS via OffscreenCanvas, which
// carries no real drift risk; only the terrarium value formula is shared
// Go code here).
func jsDecodeTerrarium(this js.Value, args []js.Value) any {
	rgba := args[0]
	n := rgba.Get("length").Int()
	if n != tileSize*tileSize*4 {
		panic(fmt.Sprintf("hopreach wasm: decodeTerrarium: expected %d RGBA bytes, got %d", tileSize*tileSize*4, n))
	}
	buf := make([]byte, n)
	js.CopyBytesToGo(buf, rgba)

	out := make([]byte, tileSize*tileSize*4)
	for i := 0; i < tileSize*tileSize; i++ {
		r := float64(buf[i*4])
		g := float64(buf[i*4+1])
		b := float64(buf[i*4+2])
		elev := float32(r*256 + g + b/256 - 32768)
		binary.LittleEndian.PutUint32(out[i*4:], math.Float32bits(elev))
	}

	jsOut := js.Global().Get("Uint8Array").New(len(out))
	js.CopyBytesToJS(jsOut, out)
	return jsOut
}

// jsCreateGrid(zoom, minTileX, minTileY, tilesWide, tilesHigh, elevBytes)
// -> handle. elevBytes is the little-endian float32 mosaic bytes the
// caller has already assembled from decodeTerrarium'd tiles (see
// buildLocalGrid in public/wasm-bridge.js).
func jsCreateGrid(this js.Value, args []js.Value) any {
	zoom := args[0].Int()
	minTileX := args[1].Int()
	minTileY := args[2].Int()
	tilesWide := args[3].Int()
	tilesHigh := args[4].Int()
	elevBytesJS := args[5]

	n := elevBytesJS.Get("length").Int()
	buf := make([]byte, n)
	js.CopyBytesToGo(buf, elevBytesJS)

	elev := make([]float32, n/4)
	for i := range elev {
		elev[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
	}

	grid, err := demgrid.NewFromElev(zoom, minTileX, minTileY, tilesWide, tilesHigh, elev)
	if err != nil {
		panic("hopreach wasm: createGrid: " + err.Error())
	}

	h := newHandle()
	mu.Lock()
	gridReg[h] = grid
	mu.Unlock()
	return h
}

func jsReleaseGrid(this js.Value, args []js.Value) any {
	h := args[0].Int()
	mu.Lock()
	delete(gridReg, h)
	mu.Unlock()
	return nil
}

func jsGridAt(this js.Value, args []js.Value) any {
	mu.Lock()
	g := gridReg[args[0].Int()]
	mu.Unlock()
	lat, lon := args[1].Float(), args[2].Float()
	return g.At(lat, lon)
}

// jsPathMargin(gridHandle, paramsHandle, txLat, txLon, txHeightM, rxLat,
// rxLon, distanceKm) -> margin dB. The hot-path function every planning
// search calls, potentially thousands of times per computation — hence
// handles instead of re-marshaling the grid/params on every call.
func jsPathMargin(this js.Value, args []js.Value) any {
	mu.Lock()
	g := gridReg[args[0].Int()]
	p := paramsReg[args[1].Int()]
	mu.Unlock()
	txLat, txLon, txHeightM := args[2].Float(), args[3].Float(), args[4].Float()
	rxLat, rxLon, distanceKm := args[5].Float(), args[6].Float(), args[7].Float()
	return propagation.PathMargin(g, p, txLat, txLon, txHeightM, rxLat, rxLon, distanceKm)
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("createParams", js.FuncOf(jsCreateParams))
	api.Set("releaseParams", js.FuncOf(jsReleaseParams))
	api.Set("haversineKm", js.FuncOf(jsHaversineKm))
	api.Set("linkBudgetMaxRangeKm", js.FuncOf(jsLinkBudgetMaxRangeKm))
	api.Set("decodeTerrarium", js.FuncOf(jsDecodeTerrarium))
	api.Set("createGrid", js.FuncOf(jsCreateGrid))
	api.Set("releaseGrid", js.FuncOf(jsReleaseGrid))
	api.Set("gridAt", js.FuncOf(jsGridAt))
	api.Set("pathMargin", js.FuncOf(jsPathMargin))
	registerMeshsim(api)
	js.Global().Set("__hopreachWasm", api)

	// Signals public/wasm-bridge.js that __hopreachWasm is fully populated
	// and safe to call — resolving a JS-side promise races the WASM
	// module's own async instantiation otherwise.
	js.Global().Call("__hopreachWasmReady")

	select {} // keep the program (and its exported funcs) alive
}
