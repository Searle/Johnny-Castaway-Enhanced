// Command tsextract decodes one TTM animation from the already-extracted
// assets/RESOURCE.{MAP,001} into a form the TypeScript/Vite slice can consume:
//
//   - one PNG per sprite cel (RGBA, magenta key colour made transparent)
//   - a manifest.json describing the palette, the sprite sheet, and the TTM's
//     decoded opcode stream (so the TS interpreter has no binary parsing to do)
//
// It is a faithful, stdlib-only port of the repo's own resource pipeline
// (resource.go, uncompress.go, graphics.go grLoadBmp/grLoadPalette, ttm.go).
// Nothing here depends on raylib, so it builds and runs anywhere Go does.
//
// This is its own tiny Go module (johnnycastaway/tsextract) so ts/ stays
// self-contained and doesn't depend on the root Go build. Run it from ts/ via
// the npm script, which cd's into this directory:
//
//	npm run extract -- -ttm MJJOG.TTM      # from ts/
//	go run . -ttm MJJOG.TTM                 # from ts/tools/tsextract/
//
// Default paths are relative to this tool's directory: it reads
// ../../../assets/RESOURCE.{MAP,001} (the repo-root assets dir, shared with the
// Go build) and writes to ../../public/anim (i.e. ts/public/anim).
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	ttmName := flag.String("ttm", "MJJOG.TTM", "TTM resource name to extract (single mode)")
	all := flag.Bool("all", false, "extract every TTM into <out>/<TTM>/ subdirs and write index.json (for the scene browser)")
	assets := flag.String("assets", "../../../assets", "dir holding RESOURCE.MAP and RESOURCE.001")
	out := flag.String("out", "../../public/anim", "output dir for PNGs + manifest.json")
	flag.Parse()

	mapData, err := os.ReadFile(filepath.Join(*assets, "RESOURCE.MAP"))
	must(err, "read RESOURCE.MAP")
	resData, err := os.ReadFile(filepath.Join(*assets, "RESOURCE.001"))
	must(err, "read RESOURCE.001")

	res := parseResources(mapData, resData)

	pal, ok := res.pals["JOHNCAST.PAL"]
	if !ok {
		fatal("JOHNCAST.PAL not found")
	}
	ttmPalette := buildPalette(pal)

	if *all {
		extractAll(res, ttmPalette, *out)
		return
	}

	m, err := extractOne(res, ttmPalette, strings.ToUpper(*ttmName), *out)
	must(err, "extract "+*ttmName)
	fmt.Printf("wrote %d opcodes, %d sprite sheets to %s\n", len(m.Ops), len(m.Sheets), *out)
}

// extractAll extracts every TTM into out/<NAME>/ and writes out/index.json
// listing what succeeded (name, tags, sheet count). TTMs that reference missing
// resources (e.g. the orphaned FIRE.TTM → FLAME.BMP) are skipped with a note.
func extractAll(res *resources, ttmPalette [16][3]uint8, out string) {
	must(os.MkdirAll(out, 0o755), "mkdir out")

	names := make([]string, 0, len(res.ttms))
	for n := range res.ttms {
		names = append(names, n)
	}
	sort.Strings(names)

	type indexEntry struct {
		Name string `json:"name"` // e.g. "MJJOG.TTM"
		Dir  string `json:"dir"`  // subdir under out, e.g. "MJJOG.TTM"
		Tags []int  `json:"tags"` // scene entry tags
		// DefaultTag is the first tag whose body actually draws a sprite, so the
		// browser skips "bootstrap" tags that only load resources then PURGE
		// (e.g. SUZYCITY tag 1 loads BMPs and hands off to the drawing tag 2).
		DefaultTag int `json:"defaultTag"`
		Sheets     int `json:"sheets"` // sprite sheet count
	}
	var index []indexEntry
	var skipped []string

	for _, n := range names {
		m, err := extractOne(res, ttmPalette, n, filepath.Join(out, n))
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (%v)", n, err))
			fmt.Fprintf(os.Stderr, "[tsextract] skip %s: %v\n", n, err)
			continue
		}
		var tags []int
		defaultTag := -1
		curTag := -1
		curDraws := false
		flush := func() {
			// When leaving a tag's body, if it drew and we haven't picked a
			// default yet, this is the first drawing tag.
			if defaultTag < 0 && curTag >= 0 && curDraws {
				defaultTag = curTag
			}
		}
		for _, op := range m.Ops {
			switch op.Op {
			case 0x1111, 0x1101: // TAG / LOCAL_TAG
				flush()
				if len(op.Args) > 0 {
					tags = append(tags, int(op.Args[0]))
					curTag = int(op.Args[0])
					curDraws = false
				}
			case 0xA504, 0xA524: // DRAW_SPRITE / DRAW_SPRITE_FLIP
				curDraws = true
			}
		}
		flush()
		if defaultTag < 0 && len(tags) > 0 {
			defaultTag = tags[0] // no tag draws (shouldn't happen) — fall back
		}
		index = append(index, indexEntry{Name: n, Dir: n, Tags: tags, DefaultTag: defaultTag, Sheets: len(m.Sheets)})
	}

	// Extract the ADS scene-director scripts (they reference the TTMs above,
	// already written to <out>/<TTM>/).
	adsIndex, adsSkipped := extractAllAds(res, out)
	skipped = append(skipped, adsSkipped...)

	ij, err := json.MarshalIndent(struct {
		TTMs    []indexEntry    `json:"ttms"`
		ADS     []adsIndexEntry `json:"ads"`
		Skipped []string        `json:"skipped,omitempty"`
	}{index, adsIndex, skipped}, "", "  ")
	must(err, "marshal index")
	must(os.WriteFile(filepath.Join(out, "index.json"), ij, 0o644), "write index.json")

	fmt.Printf("extracted %d/%d TTMs and %d ADS scripts (%d skipped) → %s/index.json\n",
		len(index), len(names), len(adsIndex), len(skipped), out)
}

// adsIndexEntry catalogs one extracted ADS script for the browser.
type adsIndexEntry struct {
	Name string `json:"name"` // e.g. "MARY.ADS"
	Dir  string `json:"dir"`  // subdir under <out>/ads
	Tags []int  `json:"tags"` // ADS entry tags (scene sequences)
}

// AdsFile is the per-ADS JSON: the slot->TTM map and the decoded opcode stream.
type AdsFile struct {
	Name string   `json:"name"`
	Res  []AdsRes `json:"res"` // TTM slot id -> TTM resource name
	Ops  []Op     `json:"ops"` // decoded ADS bytecode
}
type AdsRes struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// extractAllAds decodes every ADS script into <out>/ads/<NAME>/ads.json and
// returns their index entries. ADS whose referenced TTMs weren't extractable
// are still emitted (the TTM pass records its own skips separately).
func extractAllAds(res *resources, out string) ([]adsIndexEntry, []string) {
	names := make([]string, 0, len(res.adss))
	for n := range res.adss {
		names = append(names, n)
	}
	sort.Strings(names)

	var index []adsIndexEntry
	var skipped []string
	for _, n := range names {
		ads := res.adss[n]
		ops := decodeADS(ads.data)

		af := AdsFile{Name: n}
		for _, r := range ads.res {
			af.Res = append(af.Res, AdsRes{ID: int(r.id), Name: r.name})
		}
		af.Ops = ops

		// ADS entry tags = the :TAG markers (opcodes not in adsArgCounts).
		var tags []int
		for _, op := range ops {
			if _, known := adsArgCounts[op.Op]; !known {
				tags = append(tags, int(op.Op))
			}
		}

		dir := filepath.Join(out, "ads", n)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (%v)", n, err))
			continue
		}
		mf, err := json.MarshalIndent(af, "", "  ")
		if err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (%v)", n, err))
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, "ads.json"), mf, 0o644); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (%v)", n, err))
			continue
		}
		index = append(index, adsIndexEntry{Name: n, Dir: n, Tags: tags})
	}
	return index, skipped
}

// extractOne decodes one TTM and writes its PNGs + manifest.json into outDir.
// Returns an error (rather than exiting) so batch mode can skip bad TTMs.
func extractOne(res *resources, ttmPalette [16][3]uint8, ttmName, outDir string) (*Manifest, error) {
	ttm, ok := res.ttms[ttmName]
	if !ok {
		return nil, fmt.Errorf("TTM not found")
	}

	ops := decodeTTM(ttm.data)

	// Which BMPs / screens does this TTM load? (LOAD_IMAGE / LOAD_SCREEN
	// opcodes carry the name.)
	var bmpNames, scrNames []string
	seen := map[string]bool{}
	for _, op := range ops {
		switch op.Op {
		case 0xF02F: // LOAD_IMAGE
			if n := strings.ToUpper(op.Str); n != "" && !seen[n] {
				seen[n] = true
				bmpNames = append(bmpNames, n)
			}
		case 0xF01F: // LOAD_SCREEN
			if n := strings.ToUpper(op.Str); n != "" && !seen[n] {
				seen[n] = true
				scrNames = append(scrNames, n)
			}
		}
	}
	if len(bmpNames) == 0 {
		return nil, fmt.Errorf("no LOAD_IMAGE opcode")
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}

	palette := make([]string, 16)
	for i, c := range ttmPalette {
		// ttmPalette is stored B,G,R (see buildPalette); emit as #rrggbb.
		palette[i] = fmt.Sprintf("#%02x%02x%02x", c[2], c[1], c[0])
	}

	manifest := Manifest{TTM: ttmName, Palette: palette, Ops: ops}

	for _, sn := range scrNames {
		scr, ok := res.scrs[sn]
		if !ok {
			return nil, fmt.Errorf("SCR %q not found", sn)
		}
		img := decodeScr(scr, ttmPalette)
		file := strings.TrimSuffix(sn, ".SCR") + ".scr.png"
		if err := writePNG(filepath.Join(outDir, file), img); err != nil {
			return nil, err
		}
		manifest.Screens = append(manifest.Screens, ManifestSheet{
			Name:    sn,
			Sprites: []ManifestSprite{{File: file, W: scr.width, H: scr.height}},
		})
	}

	for _, bn := range bmpNames {
		bmp, ok := res.bmps[bn]
		if !ok {
			return nil, fmt.Errorf("BMP %q not found", bn)
		}
		sheet := decodeBmp(bmp, ttmPalette)
		ms := ManifestSheet{Name: bn, Sprites: make([]ManifestSprite, len(sheet))}
		for i, spr := range sheet {
			file := fmt.Sprintf("%s.%d.png", strings.TrimSuffix(bn, ".BMP"), i)
			if err := writePNG(filepath.Join(outDir, file), spr); err != nil {
				return nil, err
			}
			ms.Sprites[i] = ManifestSprite{File: file, W: spr.Bounds().Dx(), H: spr.Bounds().Dy()}
		}
		manifest.Sheets = append(manifest.Sheets, ms)
	}

	mf, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(outDir, "manifest.json"), mf, 0o644); err != nil {
		return nil, err
	}
	return &manifest, nil
}

// ---- manifest types ----

type Manifest struct {
	TTM string `json:"ttm"`
	// Palette is the 16 draw colours as "#rrggbb", indexed by colour index &
	// 0x0f — used by the primitive opcodes (DRAW_LINE/RECT/CIRCLE/PIXEL).
	Palette []string        `json:"palette"`
	Screens []ManifestSheet `json:"screens,omitempty"`
	Sheets  []ManifestSheet `json:"sheets"`
	Ops     []Op            `json:"ops"`
}
type ManifestSheet struct {
	Name    string           `json:"name"`
	Sprites []ManifestSprite `json:"sprites"`
}
type ManifestSprite struct {
	File string `json:"file"`
	W    int    `json:"w"`
	H    int    `json:"h"`
}

// Op is one decoded TTM instruction. Args holds up to numArgs uint16s; Str
// holds the inline string for the 0x?F opcodes (e.g. LOAD_IMAGE).
type Op struct {
	Op   uint16   `json:"op"`
	Args []uint16 `json:"args,omitempty"`
	Str  string   `json:"str,omitempty"`
}

// ---- resource parsing (port of resource.go, stdlib only) ----

type bmpResource struct {
	widths, heights []uint16
	numImages       int
	data            []byte
}
type ttmResource struct{ data []byte }
type scrResource struct {
	width, height int
	data          []byte
}
type palResource [256][3]uint8 // R,G,B as stored (6-bit VGA)

// adsResource is a parsed .ADS scene-director script: the RES table maps a TTM
// slot id -> TTM resource name, and data is the decompressed ADS bytecode.
type adsResource struct {
	res  []adsRes // slot id -> TTM name
	data []byte   // decompressed ADS opcode stream
}
type adsRes struct {
	id   uint16
	name string
}

type resources struct {
	bmps map[string]*bmpResource
	ttms map[string]*ttmResource
	scrs map[string]*scrResource
	pals map[string]palResource
	adss map[string]*adsResource
}

func parseResources(mapData, resData []byte) *resources {
	r := &resources{
		bmps: map[string]*bmpResource{},
		ttms: map[string]*ttmResource{},
		scrs: map[string]*scrResource{},
		pals: map[string]palResource{},
		adss: map[string]*adsResource{},
	}

	// RESOURCE.MAP: 6 unknown + 13 filename + uint16 numEntries + (len u32, off u32)*
	mb := bytes.NewReader(mapData)
	skip(mb, 6+13)
	numEntries := ru16(mb)
	type entry struct{ off uint32 }
	entries := make([]entry, numEntries)
	for i := range entries {
		_ = ru32(mb) // length (unused)
		entries[i].off = ru32(mb)
	}

	for _, e := range entries {
		if int(e.off)+17 > len(resData) {
			continue
		}
		b := bytes.NewReader(resData[e.off:])
		nameBytes := make([]byte, 13)
		binary.Read(b, binary.LittleEndian, nameBytes)
		dot := bytes.IndexByte(nameBytes, '.')
		if dot < 0 {
			continue
		}
		end := dot + 4
		if end > len(nameBytes) {
			end = len(nameBytes)
		}
		name := strings.TrimRight(string(nameBytes[:end]), "\x00")
		_ = ru32(b) // resSize (unused)

		switch name[dot:] {
		case ".BMP":
			r.bmps[strings.ToUpper(name)] = parseBmp(b)
		case ".TTM":
			r.ttms[strings.ToUpper(name)] = parseTtm(b)
		case ".SCR":
			r.scrs[strings.ToUpper(name)] = parseScr(b)
		case ".PAL":
			r.pals[strings.ToUpper(name)] = parsePal(b)
		case ".ADS":
			r.adss[strings.ToUpper(name)] = parseAds(b)
		}
	}
	return r
}

func parseBmp(b *bytes.Reader) *bmpResource {
	readTag(b, "BMP:")
	_ = ru16(b) // width
	_ = ru16(b) // height
	readTag(b, "INF:")
	_ = ru32(b) // dataSize
	numImages := int(ru16(b))
	widths := ru16Block(b, numImages)
	heights := ru16Block(b, numImages)
	readTag(b, "BIN:")
	compressedSize := ru32(b) - 5
	method := ru8(b)
	uncompressedSize := ru32(b)
	data := uncompress(b, method, compressedSize, uncompressedSize)
	return &bmpResource{widths: widths, heights: heights, numImages: numImages, data: data}
}

func parseTtm(b *bytes.Reader) *ttmResource {
	readTag(b, "VER:")
	verSize := ru32(b)
	skip(b, int(verSize))
	readTag(b, "PAG:")
	_ = ru32(b)
	_ = ru8(b)
	_ = ru8(b)
	readTag(b, "TT3:")
	compressedSize := ru32(b) - 5
	method := ru8(b)
	uncompressedSize := ru32(b)
	data := uncompress(b, method, compressedSize, uncompressedSize)
	// (TTI:/TAG: sections follow but the slice doesn't need them)
	return &ttmResource{data: data}
}

func parseScr(b *bytes.Reader) *scrResource {
	readTag(b, "SCR:")
	_ = ru16(b) // totalSize
	_ = ru16(b) // flags
	readTag(b, "DIM:")
	_ = ru32(b) // dimSize
	width := int(ru16(b))
	height := int(ru16(b))
	readTag(b, "BIN:")
	compressedSize := ru32(b) - 5
	method := ru8(b)
	uncompressedSize := ru32(b)
	data := uncompress(b, method, compressedSize, uncompressedSize)
	return &scrResource{width: width, height: height, data: data}
}

// parseAds mirrors resource.go parseAdsResource. Layout:
//
//	VER: <u32 size> <bytes>
//	ADS: <4 bytes>
//	RES: <u32 resSize> <u16 numRes> then numRes × (u16 id, null-terminated name)
//	SCR: <u32 compressedSize> <u8 method> <u32 uncompressedSize> <stream>
//	TAG: … (not needed; the runtime re-scans the decompressed bytecode)
//
// RES names are variable-length null-terminated, NOT fixed 40-byte records —
// reading them fixed-width misaligns the stream (notably for JOHNNY.ADS).
func parseAds(b *bytes.Reader) *adsResource {
	readTag(b, "VER:")
	verSize := ru32(b)
	skip(b, int(verSize))

	readTag(b, "ADS:")
	skip(b, 4) // AdsUnknown

	readTag(b, "RES:")
	resSize := ru32(b)
	numRes := int(ru16(b))
	res := make([]adsRes, 0, numRes)
	bytesRead := uint32(0)
	for i := 0; i < numRes && bytesRead < resSize-2; i++ {
		id := ru16(b)
		bytesRead += 2
		var nameBytes []byte
		for {
			c := ru8(b)
			bytesRead++
			if c == 0 {
				break
			}
			nameBytes = append(nameBytes, c)
		}
		res = append(res, adsRes{id: id, name: strings.ToUpper(string(nameBytes))})
	}

	readTag(b, "SCR:")
	compressedSize := ru32(b) - 5
	method := ru8(b)
	uncompressedSize := ru32(b)
	data := uncompress(b, method, compressedSize, uncompressedSize)
	return &adsResource{res: res, data: data}
}

func parsePal(b *bytes.Reader) palResource {
	readTag(b, "PAL:")
	_ = ru16(b) // size
	_ = ru8(b)
	_ = ru8(b)
	readTag(b, "VGA:")
	skip(b, 4)
	var pal palResource
	for i := 0; i < 256; i++ {
		pal[i][0] = ru8(b) // R
		pal[i][1] = ru8(b) // G
		pal[i][2] = ru8(b) // B
	}
	return pal
}

// ---- palette + sprite decode (port of graphics.go) ----

// buildPalette mirrors grLoadPalette: 6-bit VGA values shifted to 8-bit, and
// stored B,G,R (grLoadBmp then reads them back as R=clr[2],G=clr[1],B=clr[0]).
func buildPalette(pal palResource) [16][3]uint8 {
	var out [16][3]uint8
	for i := 0; i < 16; i++ {
		out[i][0] = pal[i][2] << 2 // B
		out[i][1] = pal[i][1] << 2 // G
		out[i][2] = pal[i][0] << 2 // R
	}
	return out
}

// decodeBmp mirrors grLoadBmp: 4bpp indexed, high nibble first, next cel begins
// one byte after the previous cel's last byte. Magenta key (0xa8,0x00,0xa8)
// becomes transparent.
func decodeBmp(bmp *bmpResource, palette [16][3]uint8) []*image.RGBA {
	sprites := make([]*image.RGBA, bmp.numImages)
	data := bmp.data
	for img := 0; img < bmp.numImages; img++ {
		w := int(bmp.widths[img])
		h := int(bmp.heights[img])
		bytesPerRow := w / 2
		rgba := image.NewRGBA(image.Rect(0, 0, w, h))
		dataOffset := 0
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				byteIdx := y*bytesPerRow + x/2
				var idx int
				if x%2 == 0 {
					idx = int((data[byteIdx] >> 4) & 0x0f)
				} else {
					idx = int(data[byteIdx] & 0x0f)
				}
				clr := palette[idx]
				// clr is stored B,G,R (see buildPalette); grLoadBmp emits
				// R=clr[2], G=clr[1], B=clr[0].
				r, g, bl := clr[2], clr[1], clr[0]
				c := color.RGBA{R: r, G: g, B: bl, A: 0xff}
				if clr[0] == 0xa8 && clr[1] == 0x00 && clr[2] == 0xa8 {
					c = color.RGBA{} // transparent key colour
				}
				rgba.SetRGBA(x, y, c)
				dataOffset = byteIdx
			}
		}
		data = data[dataOffset+1:]
		sprites[img] = rgba
	}
	return sprites
}

// decodeScr mirrors grLoadScreen: 4bpp indexed, no transparency, with the
// edge-column fixup (leftmost col reads col 2, rightmost reads width-3).
func decodeScr(scr *scrResource, palette [16][3]uint8) *image.RGBA {
	w, h := scr.width, scr.height
	bytesPerRow := w / 2
	data := scr.data
	rgba := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			targetX := x
			if x == 0 {
				targetX = 2
			} else if x == w-1 {
				targetX = w - 3
			}
			byteIdx := y*bytesPerRow + targetX/2
			var idx int
			if targetX%2 == 0 {
				idx = int((data[byteIdx] >> 4) & 0x0f)
			} else {
				idx = int(data[byteIdx] & 0x0f)
			}
			clr := palette[idx]
			rgba.SetRGBA(x, y, color.RGBA{R: clr[2], G: clr[1], B: clr[0], A: 0xff})
		}
	}
	return rgba
}

// ---- TTM opcode decode (port of ttm.go ttmPlay's parse loop) ----

func decodeTTM(data []byte) []Op {
	var ops []Op
	var offset uint32
	size := uint32(len(data))
	for offset < size {
		op := peek16(data, &offset)
		numArgs := uint8(op) & 0x0f
		var o Op
		o.Op = op
		if numArgs == 0x0f {
			var sb []byte
			for data[offset] != 0 {
				sb = append(sb, data[offset])
				offset++
			}
			offset++ // null terminator
			if len(sb)&0x01 == 0x00 {
				// original reads an even number of bytes *including* the
				// terminator; when the char count is even the terminator makes
				// it odd, so it consumes one more byte.
				offset++
			}
			o.Str = string(sb)
		} else {
			o.Args = make([]uint16, numArgs)
			for i := uint8(0); i < numArgs; i++ {
				o.Args[i] = peek16(data, &offset)
			}
		}
		ops = append(ops, o)
	}
	return ops
}

// adsArgCounts is the number of uint16 args each ADS opcode consumes (from the
// ads.go interpreter). Opcodes not listed are :TAG markers — the opcode value
// itself is the tag id, with no args.
var adsArgCounts = map[uint16]int{
	0x1070: 2, // IF_LASTPLAYED_LOCAL
	0x1330: 2, // IF_UNKNOWN_1 (ignored)
	0x1350: 2, // IF_LASTPLAYED
	0x1360: 2, // IF_NOT_RUNNING
	0x1370: 2, // IF_IS_RUNNING
	0x1420: 0, // AND
	0x1430: 0, // OR
	0x1510: 0, // PLAY_SCENE
	0x1520: 5, // ADD_SCENE_LOCAL
	0x2005: 4, // ADD_SCENE
	0x2010: 3, // STOP_SCENE
	0x2014: 0, // (seen in adsLoad; 0 args)
	0x3010: 0, // RANDOM_START
	0x3020: 1, // NOP (weight)
	0x30ff: 0, // RANDOM_END
	0x4000: 3, // UNKNOWN_6
	0xf010: 0, // FADE_OUT
	0xf200: 1, // GOSUB_TAG
	0xffff: 0, // END
	0xfff0: 0, // END_IF
}

// decodeADS decodes the ADS bytecode into a flat opcode list. Unlike TTM, ADS
// opcodes have fixed per-opcode arg counts (adsArgCounts); anything else is a
// :TAG marker whose opcode value is the tag id.
func decodeADS(data []byte) []Op {
	var ops []Op
	var offset uint32
	size := uint32(len(data))
	for offset < size {
		op := peek16(data, &offset)
		n, known := adsArgCounts[op]
		if !known {
			// :TAG marker — record it so the runtime can find chunk offsets.
			ops = append(ops, Op{Op: op})
			continue
		}
		o := Op{Op: op}
		if n > 0 {
			o.Args = make([]uint16, n)
			for i := 0; i < n; i++ {
				o.Args[i] = peek16(data, &offset)
			}
		}
		ops = append(ops, o)
	}
	return ops
}

// ---- uncompress (port of uncompress.go) ----

var (
	nextBit     int
	current     uint8
	inOffset    uint32
	maxInOffset uint32
)

func uncompress(buf *bytes.Reader, method uint8, inSize, outSize uint32) []byte {
	switch method {
	case 0:
		out := make([]byte, outSize)
		binary.Read(buf, binary.LittleEndian, out)
		return out
	case 1:
		return uncompressRLE(buf, inSize, outSize)
	case 2:
		return uncompressLZW(buf, inSize, outSize)
	default:
		fatal("unknown compression method %d", method)
		return nil
	}
}

func getByte(buf *bytes.Reader) uint8 {
	if inOffset >= maxInOffset {
		return 0
	}
	inOffset++
	b, err := buf.ReadByte()
	if err != nil {
		return 0xFF
	}
	return b
}

func getBits(buf *bytes.Reader, n uint32) uint16 {
	if n == 0 {
		return 0
	}
	x := uint32(0)
	for i := uint32(0); i < n; i++ {
		if current&(1<<nextBit) != 0 {
			x |= uint32(1) << i
		}
		nextBit++
		if nextBit > 7 {
			current = getByte(buf)
			nextBit = 0
		}
	}
	return uint16(x)
}

type codeEntry struct {
	prefix uint16
	appnd  uint8
}

func uncompressLZW(buf *bytes.Reader, inSize, outSize uint32) []byte {
	outData := make([]byte, outSize)
	stackPtr := uint32(0)
	nBits := uint8(9)
	freeEntry := uint32(257)
	var (
		decodeStack [4096]uint8
		codeTable   [4096]codeEntry
		oldCode     uint16
		lastByte    uint16
		bitPos      uint32
		outOffset   uint32
	)
	maxInOffset = inSize
	nextBit = 0
	inOffset = 0
	current = getByte(buf)
	tmp := getBits(buf, uint32(nBits))
	lastByte = tmp
	oldCode = tmp
	outData[outOffset] = uint8(oldCode)
	outOffset++
	for inOffset < inSize {
		newCode := getBits(buf, uint32(nBits))
		bitPos += uint32(nBits)
		if newCode == 256 {
			n3 := uint32(nBits << 3)
			skipN := (n3 - ((bitPos - 1) % n3)) - 1
			getBits(buf, skipN)
			nBits = 9
			freeEntry = 256
			bitPos = 0
		} else {
			code := newCode
			if uint32(code) >= freeEntry {
				if stackPtr > 4095 {
					break
				}
				decodeStack[stackPtr] = uint8(lastByte)
				stackPtr++
				code = oldCode
			}
			for code > 255 {
				if code > 4095 {
					break
				}
				decodeStack[stackPtr] = codeTable[code].appnd
				stackPtr++
				code = codeTable[code].prefix
			}
			decodeStack[stackPtr] = uint8(code)
			stackPtr++
			lastByte = code
			for stackPtr > 0 {
				stackPtr--
				if outOffset >= outSize {
					return outData
				}
				outData[outOffset] = decodeStack[stackPtr]
				outOffset++
			}
			if freeEntry < 4096 {
				codeTable[freeEntry].prefix = oldCode
				codeTable[freeEntry].appnd = uint8(lastByte)
				freeEntry++
				temp := uint32(1 << nBits)
				if freeEntry >= temp && nBits < 12 {
					nBits++
					bitPos = 0
				}
			}
			oldCode = newCode
		}
	}
	return outData
}

func uncompressRLE(buf *bytes.Reader, inSize, outSize uint32) []byte {
	outData := make([]byte, outSize)
	var outOffset uint32
	inOffset = 0
	maxInOffset = inSize
	for outOffset < outSize {
		control := ru8(buf)
		inOffset++
		if control&0x80 == 0x80 {
			length := control & 0x7F
			b := ru8(buf)
			inOffset++
			for i := 0; i < int(length); i++ {
				outData[outOffset] = b
				outOffset++
			}
		} else {
			for i := 0; i < int(control); i++ {
				outData[outOffset] = ru8(buf)
				outOffset++
				inOffset++
			}
		}
	}
	return outData
}

// ---- byte helpers (port of util.go) ----

func ru8(b *bytes.Reader) uint8 {
	v, err := b.ReadByte()
	must(err, "read byte")
	return v
}
func ru16(b *bytes.Reader) uint16 { return uint16(ru8(b)) | uint16(ru8(b))<<8 }
func ru32(b *bytes.Reader) uint32 {
	return uint32(ru8(b)) | uint32(ru8(b))<<8 | uint32(ru8(b))<<16 | uint32(ru8(b))<<24
}
func ru16Block(b *bytes.Reader, n int) []uint16 {
	out := make([]uint16, n)
	for i := range out {
		out[i] = ru16(b)
	}
	return out
}
func skip(b *bytes.Reader, n int) {
	for i := 0; i < n; i++ {
		ru8(b)
	}
}
func readTag(b *bytes.Reader, tag string) {
	got := make([]byte, len(tag))
	binary.Read(b, binary.LittleEndian, got)
	if string(got) != tag {
		fatal("expected tag %q, got %q", tag, string(got))
	}
}
func peek16(data []byte, offset *uint32) uint16 {
	r := uint16(data[*offset])
	*offset++
	r |= uint16(data[*offset]) << 8
	*offset++
	return r
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func must(err error, what string) {
	if err != nil {
		fatal("%s: %v", what, err)
	}
}
func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[tsextract] "+format+"\n", a...)
	os.Exit(1)
}
