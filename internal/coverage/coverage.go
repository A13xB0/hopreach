// Package coverage renders best-server RF coverage heatmaps: at each pixel
// it finds the repeater giving the strongest signal margin (after terrain
// diffraction loss) and colours from orange (just barely covered) to green
// (comfortably covered), fully transparent where no repeater's link budget
// reaches with positive margin. Computation goes through a
// compute.Engine (local GPU, remote GPU, or CPU) rather than calling
// propagation.ComputeMarginsCPU directly.
package coverage

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"os"
	"path/filepath"

	"hopreach/internal/compute"
	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
)

// Point is a bare lat/lon pair, used only to compute RasterBounds before any
// terrain is known.
type Point struct {
	Lat, Lon float64
}

// RasterBounds pads each point's location by rangeKm to get the area that
// could possibly be covered, before any terrain is known.
func RasterBounds(points []Point, rangeKm float64) (propagation.Bounds, bool) {
	if len(points) == 0 {
		return propagation.Bounds{}, false
	}
	const kmPerDegLat = 110.574
	south, north, west, east := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for _, pt := range points {
		kmPerDegLon := 111.320 * math.Cos(pt.Lat*math.Pi/180)
		if kmPerDegLon < 1 {
			kmPerDegLon = 1
		}
		latPad := rangeKm / kmPerDegLat
		lonPad := rangeKm / kmPerDegLon
		south = math.Min(south, pt.Lat-latPad)
		north = math.Max(north, pt.Lat+latPad)
		west = math.Min(west, pt.Lon-lonPad)
		east = math.Max(east, pt.Lon+lonPad)
	}
	return propagation.Bounds{South: south, North: north, West: west, East: east}, true
}

// marginsToImage colours a raw margins buffer (as produced by
// propagation.ComputeMarginsCPU or the GPU path) from orange (just barely
// covered) to green (comfortably covered, marginDB >= p.MarginGreenDB),
// fully transparent wherever the margin is NaN.
func marginsToImage(margins []float32, imageWidth, imageHeight int, p propagation.Params, maxAlpha uint8) *image.NRGBA {
	orange := [3]float64{249, 115, 22}
	green := [3]float64{34, 197, 94}

	img := image.NewNRGBA(image.Rect(0, 0, imageWidth, imageHeight))
	for py := 0; py < imageHeight; py++ {
		rowOffset := py * imageWidth
		for px := 0; px < imageWidth; px++ {
			m := float64(margins[rowOffset+px])
			if math.IsNaN(m) {
				continue
			}

			t := m / p.MarginGreenDB
			if t > 1 {
				t = 1
			}
			if t < 0 {
				t = 0
			}
			r := orange[0] + t*(green[0]-orange[0])
			g := orange[1] + t*(green[1]-orange[1])
			b := orange[2] + t*(green[2]-orange[2])

			img.SetNRGBA(px, py, color.NRGBA{
				R: uint8(r), G: uint8(g), B: uint8(b), A: maxAlpha,
			})
		}
	}
	return img
}

// Raster renders a best-server coverage heatmap over bounds at imageWidth
// pixels wide (height follows bounds' real-world aspect ratio). progress is
// called periodically with (rowsDone, totalRows). Uses engine's configured
// backend (local GPU, remote GPU, or CPU).
func Raster(engine *compute.Engine, grid *demgrid.Grid, sites []propagation.Site, bounds propagation.Bounds, imageWidth int, p propagation.Params, maxAlpha uint8, progress func(done, total int)) *image.NRGBA {
	width, height := dimensions(bounds, imageWidth)
	if width == 0 {
		return nil
	}
	rangeKm := propagation.LinkBudgetMaxRangeKm(p)
	margins := engine.Margins(grid, sites, bounds, width, height, rangeKm, p, progress)
	return marginsToImage(margins, width, height, p, maxAlpha)
}

// dimensions returns the raster pixel dimensions for imageWidth covering
// bounds, preserving bounds' real-world aspect ratio. (0, 0) means bounds is
// degenerate (zero width/height).
func dimensions(bounds propagation.Bounds, imageWidth int) (width, height int) {
	const kmPerDegLat = 110.574
	avgLat := (bounds.South + bounds.North) / 2
	kmPerDegLon := 111.320 * math.Cos(avgLat*math.Pi/180)
	widthKm := (bounds.East - bounds.West) * kmPerDegLon
	heightKm := (bounds.North - bounds.South) * kmPerDegLat
	if widthKm <= 0 || heightKm <= 0 {
		return 0, 0
	}
	h := int(math.Round(float64(imageWidth) * heightKm / widthKm))
	if h < 1 {
		h = 1
	}
	return imageWidth, h
}

// RasterSupersampled computes margins at servedWidth*supersample
// resolution — genuinely finer sampling of the underlying terrain/physics,
// not just a bigger output file — then box-downsamples back to servedWidth
// before colouring, so the extra detail shows up as proper anti-aliasing
// (smoother, more accurate edges) rather than inflating the size of the PNG
// actually sent to browsers. supersample<=1 behaves exactly like Raster.
func RasterSupersampled(engine *compute.Engine, grid *demgrid.Grid, sites []propagation.Site, bounds propagation.Bounds, servedWidth, supersample int, p propagation.Params, maxAlpha uint8, progress func(done, total int)) *image.NRGBA {
	servedW, servedH := dimensions(bounds, servedWidth)
	if servedW == 0 {
		return nil
	}
	if supersample < 1 {
		supersample = 1
	}
	computeW, computeH := servedW*supersample, servedH*supersample

	rangeKm := propagation.LinkBudgetMaxRangeKm(p)
	margins := engine.Margins(grid, sites, bounds, computeW, computeH, rangeKm, p, progress)
	margins, _, _ = compute.DownsampleMargins(margins, computeW, computeH, supersample)
	return marginsToImage(margins, servedW, servedH, p, maxAlpha)
}

// RasterSupersampledChunked is RasterSupersampled for regions too large to
// load as a single elevation grid (see compute.Engine.MarginsChunked) —
// used for the Precision tier, where a whole-region grid at a high DEM zoom
// can run into several GB. Takes what MarginsChunked needs to load its own
// per-band grids instead of one already-loaded *demgrid.Grid.
func RasterSupersampledChunked(engine *compute.Engine, bounds propagation.Bounds, zoom int, cacheDir, tileURLBase string, client *http.Client, sites []propagation.Site, servedWidth, supersample int, p propagation.Params, maxAlpha uint8, progress func(done, total int)) (*image.NRGBA, error) {
	servedW, servedH := dimensions(bounds, servedWidth)
	if servedW == 0 {
		return nil, nil
	}
	if supersample < 1 {
		supersample = 1
	}
	computeW, computeH := servedW*supersample, servedH*supersample

	rangeKm := propagation.LinkBudgetMaxRangeKm(p)
	// MarginsChunked downsamples internally, one geographic tile at a time,
	// so margins already comes back at served (servedW x servedH)
	// resolution — no separate whole-region downsample step needed here
	// (that used to be a second ~servedW*servedH*supersample^2*4-byte
	// buffer alongside the compute-resolution one MarginsChunked itself
	// held; see its doc comment for why avoiding that mattered).
	margins, err := engine.MarginsChunked(bounds, zoom, cacheDir, tileURLBase, client, sites, computeW, computeH, rangeKm, p, supersample, progress)
	if err != nil {
		return nil, err
	}
	return marginsToImage(margins, servedW, servedH, p, maxAlpha), nil
}

// Tile is one piece of a coverage raster split for efficient browser
// rendering — see WriteTiles.
type Tile struct {
	Image  string             `json:"image"`
	Bounds propagation.Bounds `json:"bounds"`
}

// maxTileDim caps each served tile's largest dimension. Without this, a
// single Precision-resolution raster (many thousands of pixels on a side)
// becomes one enormous browser-side image — many GPUs cap texture
// dimensions somewhere around 4096-8192px, past which the browser falls
// back to a much slower software compositing path for that whole layer,
// which reads as sluggish ("chugging") on every pan/zoom, not just a slow
// initial load. 2048 is comfortably under every common limit.
const maxTileDim = 2048

// WriteTiles slices img into a grid of at-most-maxTileDim pieces (via
// SubImage — a view, not a copy, so this doesn't duplicate pixel data in
// memory) and writes each as its own PNG under outputDir, named
// "<baseName>-<row>-<col>.png". Returns each tile's filename and lat/lon
// bounds, linearly interpolated from the source image's own bounds — img's
// pixel grid is a simple equirectangular mapping, so this is exact, not an
// approximation.
func WriteTiles(outputDir, baseName string, img *image.NRGBA, bounds propagation.Bounds) ([]Tile, error) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return nil, nil
	}

	var tiles []Tile
	for y0 := 0; y0 < h; y0 += maxTileDim {
		y1 := y0 + maxTileDim
		if y1 > h {
			y1 = h
		}
		for x0 := 0; x0 < w; x0 += maxTileDim {
			x1 := x0 + maxTileDim
			if x1 > w {
				x1 = w
			}

			sub := img.SubImage(image.Rect(b.Min.X+x0, b.Min.Y+y0, b.Min.X+x1, b.Min.Y+y1))
			tileBounds := propagation.Bounds{
				North: bounds.North - (float64(y0)/float64(h))*(bounds.North-bounds.South),
				South: bounds.North - (float64(y1)/float64(h))*(bounds.North-bounds.South),
				West:  bounds.West + (float64(x0)/float64(w))*(bounds.East-bounds.West),
				East:  bounds.West + (float64(x1)/float64(w))*(bounds.East-bounds.West),
			}

			name := fmt.Sprintf("%s-%d-%d.png", baseName, y0/maxTileDim, x0/maxTileDim)
			if err := WritePNG(filepath.Join(outputDir, name), sub); err != nil {
				return nil, fmt.Errorf("writing tile %s: %w", name, err)
			}
			tiles = append(tiles, Tile{Image: name, Bounds: tileBounds})
		}
	}
	return tiles, nil
}

// WritePNG atomically writes img as a PNG to path (write-tmp-then-rename).
func WritePNG(path string, img image.Image) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
