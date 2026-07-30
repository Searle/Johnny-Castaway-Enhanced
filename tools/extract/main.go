// Command extract fetches the copyright-clean Screen Antics / Johnny Castaway
// install disk from the Internet Archive, extracts the original game resource
// files, and writes them to assets/ so the screensaver can embed them.
//
// The RESOURCE.001 on the install disk is a stub; the real data lives in
// RESOURCE.00$, compressed with InstallShield-Z (PKWARE implode), which this
// tool decompresses (see blast.go). Outputs are verified against known MD5s.
//
// Requires the system `7z` binary (p7zip) to read the .7z archive and the
// FAT12 floppy image inside it.
//
// Usage:
//
//	go run ./tools/extract            # writes ./assets/RESOURCE.{MAP,001}
//	go run ./tools/extract -out DIR   # writes to DIR
package main

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	archiveURL = "https://archive.org/download/000580-ScreenAnticsJohnnyCastaway/000580_jonny_castaway.7z"

	md5ResourceMap = "374e6d05c5e0acd88fb5af748948c899"
	md5Resource001 = "8bb6c99e9129806b5089a39d24228a36"
)

func main() {
	out := flag.String("out", "assets", "output directory for RESOURCE.MAP and RESOURCE.001")
	url := flag.String("url", archiveURL, "archive.org .7z URL")
	flag.Parse()

	if _, err := exec.LookPath("7z"); err != nil {
		fatal("the `7z` binary is required (install p7zip): %v", err)
	}

	work, err := os.MkdirTemp("", "jc-extract-")
	if err != nil {
		fatal("temp dir: %v", err)
	}
	defer os.RemoveAll(work)

	// 1. Download the archive.
	sevenZip := filepath.Join(work, "jc.7z")
	logf("downloading %s", *url)
	if err := download(*url, sevenZip); err != nil {
		fatal("download: %v", err)
	}

	// 2. Extract disk1.img from the .7z.
	logf("extracting floppy image from archive")
	if err := run(work, "7z", "x", "-y", sevenZip); err != nil {
		fatal("7z extract archive: %v", err)
	}
	img := findFile(work, "disk1.img")
	if img == "" {
		fatal("disk1.img not found in archive")
	}

	// 3. Extract the resource files from the FAT12 floppy image.
	logf("extracting resource files from floppy image")
	diskOut := filepath.Join(work, "disk")
	if err := run(work, "7z", "x", "-y", "-o"+diskOut, img); err != nil {
		fatal("7z extract floppy: %v", err)
	}

	resMap := findFile(diskOut, "RESOURCE.MAP")
	res00 := findFile(diskOut, "RESOURCE.00$")
	if resMap == "" || res00 == "" {
		fatal("RESOURCE.MAP / RESOURCE.00$ not found on floppy (found: %v)", listDir(diskOut))
	}

	// 4. RESOURCE.MAP is stored uncompressed — copy and verify.
	mapData, err := os.ReadFile(resMap)
	if err != nil {
		fatal("read RESOURCE.MAP: %v", err)
	}
	if got := md5hex(mapData); got != md5ResourceMap {
		fatal("RESOURCE.MAP md5 mismatch: got %s want %s", got, md5ResourceMap)
	}

	// 5. RESOURCE.00$ is InstallShield-Z (PKWARE implode). Decompress it.
	logf("decompressing RESOURCE.001")
	res001Data, err := decompressResource00(res00)
	if err != nil {
		fatal("decompress RESOURCE.001: %v", err)
	}
	if got := md5hex(res001Data); got != md5Resource001 {
		fatal("RESOURCE.001 md5 mismatch: got %s want %s", got, md5Resource001)
	}

	// 6. Write outputs.
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fatal("mkdir %s: %v", *out, err)
	}
	if err := os.WriteFile(filepath.Join(*out, "RESOURCE.MAP"), mapData, 0o644); err != nil {
		fatal("write RESOURCE.MAP: %v", err)
	}
	if err := os.WriteFile(filepath.Join(*out, "RESOURCE.001"), res001Data, 0o644); err != nil {
		fatal("write RESOURCE.001: %v", err)
	}
	logf("wrote %s/RESOURCE.MAP (%d bytes) and %s/RESOURCE.001 (%d bytes) — md5 verified",
		*out, len(mapData), *out, len(res001Data))
}

// decompressResource00 reads the InstallShield-Z RESOURCE.00$ member and returns
// the decompressed RESOURCE.001. The compressed member has a small inline header
// (magic, sizes, embedded "RESOURCE.001" name) followed by a raw PKWARE-implode
// stream; we locate that stream by scanning for a valid implode header just past
// the embedded filename and taking the decode whose MD5 matches.
func decompressResource00(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// The DCL stream begins shortly after the embedded "RESOURCE.001" name.
	name := []byte("RESOURCE.001")
	base := bytes.Index(data, name)
	if base < 0 {
		base = 0
	} else {
		base += len(name)
	}
	// Scan a small window for the stream start (first byte lit flag 0/1, second
	// byte dict 4..6). Return the first offset whose decode matches the MD5.
	for start := base; start < base+16 && start+1 < len(data); start++ {
		b0, b1 := data[start], data[start+1]
		if b0 > 1 || b1 < 4 || b1 > 6 {
			continue
		}
		out, err := blast(data[start:])
		if err != nil {
			continue
		}
		if md5hex(out) == md5Resource001 {
			return out, nil
		}
	}
	return nil, fmt.Errorf("could not locate a valid PKWARE-implode stream in %s", filepath.Base(path))
}

func download(url, dst string) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

func run(dir, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s %v: %v\n%s", name, args, err, out)
	}
	return nil
}

// findFile walks root and returns the first path whose base name equals name
// (case-insensitive).
func findFile(root, name string) string {
	var found string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if equalFold(filepath.Base(p), name) {
			found = p
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

func listDir(root string) []string {
	var names []string
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

func md5hex(b []byte) string {
	sum := md5.Sum(b)
	return hex.EncodeToString(sum[:])
}

func logf(format string, a ...any) { fmt.Fprintf(os.Stderr, "[extract] "+format+"\n", a...) }
func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[extract] error: "+format+"\n", a...)
	os.Exit(1)
}
