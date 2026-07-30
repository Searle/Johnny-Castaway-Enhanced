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
	"strings"
)

func main() {
	ttmName := flag.String("ttm", "MJJOG.TTM", "TTM resource name to extract")
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

	ttm, ok := res.ttms[strings.ToUpper(*ttmName)]
	if !ok {
		fatal("TTM %q not found (have %d TTMs)", *ttmName, len(res.ttms))
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
		fatal("TTM %s loads no BMPs (no LOAD_IMAGE opcode)", *ttmName)
	}

	must(os.MkdirAll(*out, 0o755), "mkdir out")

	manifest := Manifest{TTM: strings.ToUpper(*ttmName), Ops: ops}

	for _, sn := range scrNames {
		scr, ok := res.scrs[sn]
		if !ok {
			fatal("SCR %q referenced by %s not found", sn, *ttmName)
		}
		img := decodeScr(scr, ttmPalette)
		file := strings.TrimSuffix(sn, ".SCR") + ".scr.png"
		must(writePNG(filepath.Join(*out, file), img), "write "+file)
		manifest.Screens = append(manifest.Screens, ManifestSheet{
			Name:    sn,
			Sprites: []ManifestSprite{{File: file, W: scr.width, H: scr.height}},
		})
	}

	for _, bn := range bmpNames {
		bmp, ok := res.bmps[bn]
		if !ok {
			fatal("BMP %q referenced by %s not found", bn, *ttmName)
		}
		sheet := decodeBmp(bmp, ttmPalette)
		ms := ManifestSheet{Name: bn, Sprites: make([]ManifestSprite, len(sheet))}
		for i, spr := range sheet {
			file := fmt.Sprintf("%s.%d.png", strings.TrimSuffix(bn, ".BMP"), i)
			must(writePNG(filepath.Join(*out, file), spr), "write "+file)
			ms.Sprites[i] = ManifestSprite{File: file, W: spr.Bounds().Dx(), H: spr.Bounds().Dy()}
		}
		manifest.Sheets = append(manifest.Sheets, ms)
	}

	mf, err := json.MarshalIndent(manifest, "", "  ")
	must(err, "marshal manifest")
	must(os.WriteFile(filepath.Join(*out, "manifest.json"), mf, 0o644), "write manifest")

	fmt.Printf("wrote %d opcodes, %d sprite sheets to %s\n", len(ops), len(manifest.Sheets), *out)
}

// ---- manifest types ----

type Manifest struct {
	TTM     string          `json:"ttm"`
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

type resources struct {
	bmps map[string]*bmpResource
	ttms map[string]*ttmResource
	scrs map[string]*scrResource
	pals map[string]palResource
}

func parseResources(mapData, resData []byte) *resources {
	r := &resources{bmps: map[string]*bmpResource{}, ttms: map[string]*ttmResource{}, scrs: map[string]*scrResource{}, pals: map[string]palResource{}}

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
