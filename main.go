package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	rl "github.com/gen2brain/raylib-go/raylib"
)

const (
	screenWidth  = 640
	screenHeight = 480

	// The game's logical scene coordinate space. Scripts use 0–639 × 0–349.
	// The bottom 130 rows of the 480-tall window are unused by game content.
	gameWidth  = 640
	gameHeight = 350
)

var (
	fadeInVal         = float32(255.0)
	runOnMonitorIndex int
	hasMonitorIndex   bool
	buildTime         = "Developer Build"
	isRun             = false

	// Windowed mode: a normal decorated, resizable window instead of the
	// borderless monitor-spanning screensaver window. Enabled by -window WxH
	// (e.g. -window 1280x960). The scene is letterboxed (4:3) to fit.
	windowedMode bool
	windowedW    = 1280
	windowedH    = 960
)

func formatStartTime(val int) string {
	hour := val / 100
	min := val % 100
	period := "AM"
	if hour >= 12 {
		period = "PM"
	}
	displayHour := hour
	if hour == 0 {
		displayHour = 12
	} else if hour > 12 {
		displayHour = hour - 12
	}
	return fmt.Sprintf("%02d:%02d %s", displayHour, min, period)
}

func adjustStartTime(val int, up bool) int {
	hour := val / 100
	min := val % 100

	totalMin := hour*60 + min
	if up {
		totalMin += 30
	} else {
		totalMin -= 30
	}

	// Wrap around 24 hours
	if totalMin >= 24*60 {
		totalMin = 0
	} else if totalMin < 0 {
		totalMin = 23*60 + 30
	}

	newHour := totalMin / 60
	newMin := totalMin % 60
	return newHour*100 + newMin
}

func runOptionsWindow() {
	preferX11Backend()
	rl.SetConfigFlags(rl.FlagWindowHighdpi)
	rl.InitWindow(600, 500, "ScreenAntics - Setup")
	defer rl.CloseWindow()
	rl.SetTargetFPS(60)

	var config TConfig
	cfgFileRead(&config)

	background := config.Background
	sounds := config.Sounds
	password := config.Password
	startTime := config.StartTime
	useMesa := config.UseMesa
	multiInstance := config.MultiInstance
	widescreen := config.Widescreen
	filterMode := config.FilterMode
	filterDropdownOpen := false
	scanlines := config.Scanlines

	// Load Windows native fonts for gorgeous anti-aliased text
	var font rl.Font
	fontLoaded := false
	winDir := os.Getenv("SystemRoot")
	if winDir == "" {
		winDir = os.Getenv("windir")
	}
	if winDir == "" {
		winDir = "C:\\Windows"
	}
	fontPaths := []string{
		winDir + "\\Fonts\\segoeui.ttf",
		winDir + "\\Fonts\\arial.ttf",
		"C:\\Windows\\Fonts\\segoeui.ttf",
		"C:\\Windows\\Fonts\\arial.ttf",
	}
	for _, fontPath := range fontPaths {
		if _, err := os.Stat(fontPath); err == nil {
			font = rl.LoadFontEx(fontPath, 64, nil, 0)
			rl.SetTextureFilter(font.Texture, rl.FilterBilinear)
			fontLoaded = true
			break
		}
	}
	if fontLoaded {
		defer rl.UnloadFont(font)
	}

	drawText := func(text string, x, y int32, size float32, col rl.Color) {
		if fontLoaded {
			rl.DrawTextEx(font, text, rl.Vector2{X: float32(x), Y: float32(y)}, size, 0, col)
		} else {
			rl.DrawText(text, x, y, int32(size), col)
		}
	}

	measureText := func(text string, size float32) float32 {
		if fontLoaded {
			vec := rl.MeasureTextEx(font, text, size, 0)
			return vec.X
		}
		return float32(rl.MeasureText(text, int32(size)))
	}

	for !rl.WindowShouldClose() {
		// Update inputs
		mousePos := rl.GetMousePosition()
		click := rl.IsMouseButtonPressed(rl.MouseLeftButton)

		// Intercept clicks if the dropdown is open
		if filterDropdownOpen {
			optionsHover := mousePos.X >= 140 && mousePos.X <= 310 && mousePos.Y >= 296 && mousePos.Y <= 296+7*26
			if click {
				if optionsHover {
					clickedIdx := int(mousePos.Y-296) / 26
					if clickedIdx >= 0 && clickedIdx < 7 {
						filterMode = clickedIdx
					}
				}
				filterDropdownOpen = false
				click = false // Consume the click
			}
		}

		// Draw
		rl.BeginDrawing()
		rl.ClearBackground(rl.GetColor(0xf0f0f0ff)) // Standard Win32 light gray background

		// Groupbox "Setup"
		rl.DrawRectangleLines(15, 15, 570, 340, rl.Gray)
		rl.DrawRectangle(25, 5, 65, 20, rl.GetColor(0xf0f0f0ff))
		drawText("Setup", 30, 6, 16, rl.Black)

		// Start of Day Option
		drawText("Start of Day:", 30, 45, 16, rl.Black)

		// Time display box
		rl.DrawRectangle(140, 40, 110, 26, rl.White)
		rl.DrawRectangleLines(140, 40, 110, 26, rl.Gray)
		drawText(formatStartTime(startTime), 148, 44, 16, rl.Black)

		// Time Up/Down Arrow buttons
		// Up button
		upHover := mousePos.X >= 255 && mousePos.X <= 275 && mousePos.Y >= 40 && mousePos.Y <= 52
		upCol := rl.GetColor(0xe1e1e1ff)
		if upHover {
			upCol = rl.GetColor(0xd1d1d1ff)
			if click {
				startTime = adjustStartTime(startTime, true)
			}
		}
		rl.DrawRectangle(255, 40, 20, 12, upCol)
		rl.DrawRectangleLines(255, 40, 20, 12, rl.Gray)
		drawText("^", 260, 43, 14, rl.Black)

		// Down button
		downHover := mousePos.X >= 255 && mousePos.X <= 275 && mousePos.Y >= 54 && mousePos.Y <= 66
		downCol := rl.GetColor(0xe1e1e1ff)
		if downHover {
			downCol = rl.GetColor(0xd1d1d1ff)
			if click {
				startTime = adjustStartTime(startTime, false)
			}
		}
		rl.DrawRectangle(255, 54, 20, 12, downCol)
		rl.DrawRectangleLines(255, 54, 20, 12, rl.Gray)
		drawText("v", 261, 51, 12, rl.Black)

		// --- COLUMN 1 (x=30) ---

		// Load Background Checkbox
		bgHover := mousePos.X >= 30 && mousePos.X <= 280 && mousePos.Y >= 90 && mousePos.Y <= 125
		rl.DrawRectangle(30, 95, 18, 18, rl.White)
		rl.DrawRectangleLines(30, 95, 18, 18, rl.Gray)
		if background {
			rl.DrawRectangle(34, 99, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Load Background", 60, 96, 16, rl.Black)
		if bgHover && click {
			background = !background
		}

		// Password Checkbox
		passHover := mousePos.X >= 30 && mousePos.X <= 280 && mousePos.Y >= 150 && mousePos.Y <= 185
		rl.DrawRectangle(30, 155, 18, 18, rl.White)
		rl.DrawRectangleLines(30, 155, 18, 18, rl.Gray)
		if password {
			rl.DrawRectangle(34, 159, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Password Protection", 60, 156, 16, rl.Black)
		if passHover && click {
			password = !password
		}

		// Sounds Checkbox
		sndHover := mousePos.X >= 30 && mousePos.X <= 280 && mousePos.Y >= 210 && mousePos.Y <= 245
		rl.DrawRectangle(30, 215, 18, 18, rl.White)
		rl.DrawRectangleLines(30, 215, 18, 18, rl.Gray)
		if sounds {
			rl.DrawRectangle(34, 219, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Sounds", 60, 216, 16, rl.Black)
		if sndHover && click {
			sounds = !sounds
		}

		// --- COLUMN 2 (x=320) ---

		// Widescreen Checkbox
		wsHover := mousePos.X >= 320 && mousePos.X <= 570 && mousePos.Y >= 90 && mousePos.Y <= 125
		rl.DrawRectangle(320, 95, 18, 18, rl.White)
		rl.DrawRectangleLines(320, 95, 18, 18, rl.Gray)
		if widescreen {
			rl.DrawRectangle(324, 99, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Widescreen", 350, 96, 16, rl.Black)
		if wsHover && click {
			widescreen = !widescreen
		}

		// Software OpenGL Checkbox
		swHover := mousePos.X >= 320 && mousePos.X <= 570 && mousePos.Y >= 150 && mousePos.Y <= 185
		rl.DrawRectangle(320, 155, 18, 18, rl.White)
		rl.DrawRectangleLines(320, 155, 18, 18, rl.Gray)
		if useMesa {
			rl.DrawRectangle(324, 159, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Use Software OpenGL (Mesa)", 350, 156, 16, rl.Black)
		if swHover && click {
			useMesa = !useMesa
		}

		// Independent instances checkbox
		miHover := mousePos.X >= 320 && mousePos.X <= 570 && mousePos.Y >= 210 && mousePos.Y <= 245
		rl.DrawRectangle(320, 215, 18, 18, rl.White)
		rl.DrawRectangleLines(320, 215, 18, 18, rl.Gray)
		if multiInstance {
			rl.DrawRectangle(324, 219, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Independent instances", 350, 216, 16, rl.Black)
		if miHover && click {
			multiInstance = !multiInstance
		}

		// Scaling Filter Option
		drawText("Scaling Filter:", 30, 275, 16, rl.Black)

		// Filter display box
		filterNames := []string{
			"Nearest",
			"Bilinear",
			"Sharp Bilinear",
			"CRT Dither",
			"Smart Dither",
			"Aperture Grille",
			"CRT Simulator",
		}

		// Draw header box
		rl.DrawRectangle(140, 270, 170, 26, rl.White)
		rl.DrawRectangleLines(140, 270, 170, 26, rl.Gray)
		drawText(filterNames[filterMode], 148, 274, 16, rl.Black)

		// Draw small down arrow box on the right
		rl.DrawRectangle(290, 271, 19, 24, rl.GetColor(0xe1e1e1ff))
		rl.DrawLine(290, 270, 290, 296, rl.Gray)
		drawText("v", 296, 277, 12, rl.Black)

		headerHover := mousePos.X >= 140 && mousePos.X <= 310 && mousePos.Y >= 270 && mousePos.Y <= 296
		if headerHover && click {
			filterDropdownOpen = !filterDropdownOpen
			click = false // Consume the click
		}

		// Scanlines Checkbox (Column 2, aligned with Scaling Filter)
		slHover := mousePos.X >= 320 && mousePos.X <= 570 && mousePos.Y >= 270 && mousePos.Y <= 305
		rl.DrawRectangle(320, 275, 18, 18, rl.White)
		rl.DrawRectangleLines(320, 275, 18, 18, rl.Gray)
		if scanlines {
			rl.DrawRectangle(324, 279, 10, 10, rl.GetColor(0x0078d7ff))
		}
		drawText("Scanlines", 350, 276, 16, rl.Black)
		if slHover && click {
			scanlines = !scanlines
		}

		// Skooter Blog branding link
		brandText := "Visite o Skooter Blog: www.skooterblog.com"
		brandSize := float32(16)
		brandWidth := measureText(brandText, brandSize)
		brandX := int32((600 - brandWidth) / 2)
		brandY := int32(375)

		brandHover := mousePos.X >= float32(brandX) && mousePos.X <= float32(brandX)+brandWidth &&
			mousePos.Y >= float32(brandY-4) && mousePos.Y <= float32(brandY+18)

		brandCol := rl.GetColor(0x555555ff)
		if brandHover {
			brandCol = rl.GetColor(0x0066ccff)
			rl.SetMouseCursor(rl.MouseCursorPointingHand)
			if click {
				openURL("https://www.skooterblog.com/")
			}
		} else {
			rl.SetMouseCursor(rl.MouseCursorDefault)
		}

		drawText(brandText, brandX, brandY, brandSize, brandCol)
		if brandHover {
			rl.DrawLine(brandX, brandY+15, brandX+int32(brandWidth), brandY+15, brandCol)
		}

		// OK Button
		okHover := mousePos.X >= 180 && mousePos.X <= 280 && mousePos.Y >= 410 && mousePos.Y <= 450
		okCol := rl.GetColor(0xe1e1e1ff)
		if okHover {
			okCol = rl.GetColor(0xd1d1d1ff)
			if click {
				config.Background = background
				config.Sounds = sounds
				config.Password = password
				config.StartTime = startTime
				config.UseMesa = useMesa
				config.MultiInstance = multiInstance
				config.Widescreen = widescreen
				config.FilterMode = filterMode
				config.Scanlines = scanlines
				cfgFileWrite(&config)
				break
			}
		}
		rl.DrawRectangle(180, 410, 100, 40, okCol)
		rl.DrawRectangleLines(180, 410, 100, 40, rl.Gray)
		drawText("OK", 218, 419, 16, rl.Black)

		// Cancel Button
		cancelHover := mousePos.X >= 320 && mousePos.X <= 420 && mousePos.Y >= 410 && mousePos.Y <= 450
		cancelCol := rl.GetColor(0xe1e1e1ff)
		if cancelHover {
			cancelCol = rl.GetColor(0xd1d1d1ff)
			if click {
				break
			}
		}
		rl.DrawRectangle(320, 410, 100, 40, cancelCol)
		rl.DrawRectangleLines(320, 410, 100, 40, rl.Gray)
		drawText("Cancel", 342, 419, 16, rl.Black)

		// Build Time stamp
		buildText := "Build: " + buildTime
		buildSize := float32(14)
		buildWidth := measureText(buildText, buildSize)
		buildX := int32((600 - buildWidth) / 2)
		buildY := int32(465)
		drawText(buildText, buildX, buildY, buildSize, rl.GetColor(0x444444ff))

		// Draw dropdown options overlay if open
		if filterDropdownOpen {
			// Draw dropdown background shadow/borders
			rl.DrawRectangle(140, 296, 170, 7*26, rl.White)
			rl.DrawRectangleLines(140, 296, 170, 7*26, rl.Gray)

			for i := 0; i < 7; i++ {
				optY := int32(296 + i*26)
				optHover := mousePos.X >= 140 && mousePos.X <= 310 && mousePos.Y >= float32(optY) && mousePos.Y <= float32(optY+26)

				if optHover {
					rl.DrawRectangle(141, optY, 168, 25, rl.GetColor(0x0078d7ff)) // Windows blue highlight
					drawText(filterNames[i], 148, optY+4, 16, rl.White)
				} else {
					drawText(filterNames[i], 148, optY+4, 16, rl.Black)
				}

				// Draw subtle separator lines between options
				if i < 6 {
					rl.DrawLine(140, optY+26, 310, optY+26, rl.GetColor(0xe0e0e0ff))
				}
			}
		}

		rl.EndDrawing()
	}
}

func main() {
	var isSettings = false
	var isPreview = false
	var isTest = false
	var isBench = false
	var isTraceServer = false
	var testAdsName = ""
	var testTagNo = 0

	for i, arg := range os.Args {
		argLower := strings.ToLower(arg)
		if strings.HasPrefix(argLower, "/c") || strings.HasPrefix(argLower, "-c") {
			isSettings = true
		} else if strings.HasPrefix(argLower, "/p") || strings.HasPrefix(argLower, "-p") {
			isPreview = true
		} else if strings.HasPrefix(argLower, "/s") || strings.HasPrefix(argLower, "-s") {
			isRun = true
		} else if argLower == "-traceserver" || argLower == "/traceserver" {
			// -traceserver: pay raylib/GL init ONCE, then read "ADS tag frames"
			// lines from stdin and emit a delimited trace block per scene. Lets
			// the oracle sweep amortize the ~2s per-process startup across all 66
			// scenes instead of relaunching. Checked before -trace / -t (shared
			// prefix). traceEnabled skips the wall-clock pacing (see graphics.go).
			isTraceServer = true
			traceEnabled = true
		} else if argLower == "-trace" || argLower == "/trace" {
			// -trace <ADS> <tag> [maxFrames]: run the scene like -t, but emit a
			// canonical draw-call trace to go-trace.txt (see trace.go) and exit
			// after maxFrames (default 120). Serves as the oracle for the ts/
			// port. Checked BEFORE -t since "-trace" also has the "-t" prefix.
			isTest = true
			traceEnabled = true
			traceMaxFrame = 120
			if i+1 < len(os.Args) {
				testAdsName = os.Args[i+1]
			}
			if i+2 < len(os.Args) {
				fmt.Sscanf(os.Args[i+2], "%d", &testTagNo)
			}
			if i+3 < len(os.Args) {
				fmt.Sscanf(os.Args[i+3], "%d", &traceMaxFrame)
			}
			// Output path is $GO_TRACE_OUT or go-trace.txt. A unique path per
			// invocation avoids concurrent -trace runs clobbering each other's
			// file (which produced spurious oracle diffs).
			tracePath := os.Getenv("GO_TRACE_OUT")
			if tracePath == "" {
				tracePath = "go-trace.txt"
			}
			traceInit(tracePath)
		} else if strings.HasPrefix(argLower, "/t") || strings.HasPrefix(argLower, "-t") {
			isTest = true
			if i+1 < len(os.Args) {
				testAdsName = os.Args[i+1]
			}
			if i+2 < len(os.Args) {
				fmt.Sscanf(os.Args[i+2], "%d", &testTagNo)
			}
		} else if strings.HasPrefix(argLower, "/b") || strings.HasPrefix(argLower, "-b") {
			isBench = true
		} else if strings.HasPrefix(argLower, "/k") || strings.HasPrefix(argLower, "-k") {
			// -k enables debug hotkeys: Space=pause, M=max-speed, Enter=advance, Esc=quit
			hotKeysEnabled = true
		} else if argLower == "/window" || argLower == "-window" || argLower == "-w" || argLower == "/w" {
			// -window [WxH]: run in a normal decorated, resizable window.
			// An optional WxH (e.g. 1280x960) sets the initial size; the scene
			// is letterboxed to 4:3 inside it. Defaults to 1280x960.
			windowedMode = true
			if i+1 < len(os.Args) {
				var w, h int
				if n, _ := fmt.Sscanf(os.Args[i+1], "%dx%d", &w, &h); n == 2 && w > 0 && h > 0 {
					windowedW, windowedH = w, h
				}
			}
		} else if strings.HasPrefix(argLower, "/m") || strings.HasPrefix(argLower, "-m") {
			if i+1 < len(os.Args) {
				fmt.Sscanf(os.Args[i+1], "%d", &runOnMonitorIndex)
				hasMonitorIndex = true
			}
		}
	}

	var initialConfig TConfig
	cfgFileRead(&initialConfig)
	if !isSettings && !initialConfig.UseMesa {
		preloadNativeOpenGL()
	}

	if isSettings {
		runOptionsWindow()
		os.Exit(0)
	}
	if isPreview {
		os.Exit(0)
	}
	if isBench {
		runBenchMode()
		os.Exit(0)
	}
	if isTraceServer {
		runTraceServer()
		os.Exit(0)
	}
	if isTest {
		runTestMode(testAdsName, testTagNo)
		os.Exit(0)
	}
	if isRun || (!isSettings && !isPreview && !isBench && !isTest && !isTraceServer) {
		isScreensaverMode = true
	}
	runApp()
}

func setupApp() {
	cfgFileRead(&activeConfig)

	preferX11Backend()

	if isWeb {
		// The browser owns the canvas: no MSAA (requesting an antialiased WebGL
		// context fails to initialize on some GPUs/drivers, which crashes at the
		// first GL call), and undecorated/resizable window flags are meaningless
		// on a <canvas>. Use the plain 640x480 backing size.
		isScreensaverMode = false
		rl.InitWindow(screenWidth, screenHeight, "Johnny Castaway")
	} else if windowedMode {
		// Normal decorated, resizable window. The scene is letterboxed to fit,
		// and the window is not treated as a screensaver (no exit-on-input).
		isScreensaverMode = false
		rl.SetConfigFlags(rl.FlagMsaa4xHint | rl.FlagWindowResizable)
		rl.InitWindow(int32(windowedW), int32(windowedH), "Johnny Castaway")
	} else {
		// Enable 4x MSAA, undecorated, and resizable window flags before initialization to ensure window focus
		rl.SetConfigFlags(rl.FlagMsaa4xHint | rl.FlagWindowUndecorated | rl.FlagWindowResizable)
		rl.InitWindow(screenWidth, screenHeight, "Johnny Castaway")
	}

	if !rl.IsWindowReady() {
		panic("Fatal: Failed to initialize window. Please check your OpenGL/graphics drivers.")
	}

	if windowedMode || isWeb {
		// A single rectangle covering the whole window/canvas; grUpdateDisplay
		// letterboxes the scene into it. Recomputed each frame so live window
		// resizing keeps the scene fitted (see refreshWindowedRect).
		refreshWindowedRect()
	} else {
		// r.c. - spans the window across every connected monitor (not just the
		// current one) and records each monitor's own rectangle for the
		// renderer to draw a separate copy of the scene into. On a
		// single-monitor system this behaves exactly like the previous code.
		setupMonitors()
	}
	if !windowedMode && !isWeb {
		// Screensaver window: capture and hide the cursor. In windowed mode keep
		// the normal cursor so the window stays usable; likewise on the web,
		// where hiding/locking the pointer in a browser tab is undesirable.
		rl.DisableCursor()
		rl.HideCursor()
	}

	rl.InitAudioDevice()
	rl.SetMasterVolume(1.0)
	loadSfx()

	rl.SetTargetFPS(30)

	parseResourceFiles("assets/RESOURCE.MAP")

	doFadeIn()
	graphicsInit()
}

func doFadeIn() {
	// The web build cannot run this blocking fade loop (rl.WindowShouldClose
	// panics on web, and the browser owns the frame loop). Skip it; the scene
	// simply appears without the initial fade-in.
	if isWeb {
		return
	}

	fadeInVal = 255.0

	for !rl.WindowShouldClose() && !shouldExitApp {
		rl.BeginDrawing()

		rl.ClearBackground(rl.Blank)

		alpha := 1.0 - fadeInVal/255.0
		// r.c. - use the actual current window size, not the fixed 640x480
		// game-resolution constants. After setupMonitors() the window can
		// span multiple monitors and be much larger than 640x480; filling
		// only that fixed corner would leave the rest of the window
		// showing through as blank during this initial fade-in.
		rl.DrawRectangle(0, 0, int32(rl.GetScreenWidth()), int32(rl.GetScreenHeight()), rl.Fade(rl.Black, alpha))
		fadeInVal -= 10

		if fadeInVal <= 0 {
			return
		}

		rl.EndDrawing()
	}
}

func runStory() {
	var config TConfig
	cfgFileRead(&config)

	if config.MultiInstance && !hasMonitorIndex && isScreensaverMode {
		// Initialize a tiny hidden window to query monitors
		rl.SetConfigFlags(rl.FlagWindowHidden)
		rl.InitWindow(1, 1, "Johnny Parent")
		monitorCount := rl.GetMonitorCount()
		rl.CloseWindow()

		if monitorCount > 1 {
			// Spawn child processes for each monitor
			var wg sync.WaitGroup
			cmds := make([]*exec.Cmd, monitorCount)
			stdinPipes := make([]io.WriteCloser, monitorCount)
			shouldExitChan := make(chan struct{}, monitorCount)

			for i := 0; i < monitorCount; i++ {
				args := []string{"-m", fmt.Sprintf("%d", i)}
				if isRun {
					args = append(args, "-s")
				}
				if hotKeysEnabled {
					args = append(args, "-k")
				}
				cmd := exec.Command(os.Args[0], args...)

				pipe, err := cmd.StdinPipe()
				if err == nil {
					stdinPipes[i] = pipe
				}
				cmds[i] = cmd

				wg.Add(1)
				go func(index int, c *exec.Cmd) {
					defer wg.Done()
					err := c.Run()
					if err != nil {
						fmt.Printf("Instance %d exited: %v\n", index, err)
					}
					select {
					case shouldExitChan <- struct{}{}:
					default:
					}
				}(i, cmd)
			}

			// Wait for any child process to exit
			<-shouldExitChan

			// Clean exit: signal all other child processes to terminate gracefully
			// by closing their stdin pipes. This causes their stdin reader loop to unblock
			// and trigger a standard Raylib/GLFW teardown to cleanly restore HDR and display settings.
			for _, pipe := range stdinPipes {
				if pipe != nil {
					_ = pipe.Close()
				}
			}

			wg.Wait()
			return
		}
	}

	if hasMonitorIndex {
		// Child process: listen to standard input to receive the exit signal from the parent.
		// When the parent closes the stdin pipe, Read returns immediately, triggering clean exit.
		go func() {
			buf := make([]byte, 1)
			_, _ = os.Stdin.Read(buf)
			shouldExitApp = true
		}()
	}

	setupApp()
	defer rl.CloseWindow()
	defer rl.CloseAudioDevice()
	defer graphicsEnd()
	defer unloadSfx()

	storyPlay()
}

func singleTTM() {
	setupApp()
	defer rl.CloseWindow()
	defer graphicsEnd()
	for {
		adsPlaySingleTtm("MJFIRE.TTM")
	}
}

func runBenchMode() {
	// Mirrors jc_reborn bench mode: loads the full app, runs adsPlayBench()
	// which measures rendering throughput for 1, 4, and 8 simultaneous
	// sprite layers. The results are printed to stdout, saved to bench.log,
	// and rendered directly on screen.
	fmt.Println("\nJohnny Castaway - Render Benchmark")
	fmt.Println("-----------------------------------")
	setupApp()
	defer rl.CloseWindow()
	defer rl.CloseAudioDevice()
	defer graphicsEnd()
	defer unloadSfx()

	results := adsPlayBench()

	// Output to console and log file
	var logOutput strings.Builder
	logOutput.WriteString("Johnny Castaway - Render Benchmark Results\n")
	logOutput.WriteString("-----------------------------------\n")
	for _, res := range results {
		fmt.Println(res)
		logOutput.WriteString(res + "\n")
	}
	logOutput.WriteString("-----------------------------------\n")
	_ = os.WriteFile("bench.log", []byte(logOutput.String()), 0644)

	fmt.Println("-----------------------------------")
	fmt.Println("Benchmark complete. Results saved to bench.log. Press any key to exit.")

	// Keep the window alive to show results on screen
	rects := monitorRects
	if len(rects) == 0 {
		rects = []TMonitorRect{{X: 0, Y: 0, W: float32(rl.GetScreenWidth()), H: float32(rl.GetScreenHeight())}}
	}

	for !rl.WindowShouldClose() && !shouldExitApp {
		rl.BeginDrawing()
		rl.ClearBackground(rl.Black)

		for _, m := range rects {
			rl.DrawText("Johnny Castaway - Render Benchmark Results", int32(m.X)+60, int32(m.Y)+80, 20, rl.RayWhite)
			rl.DrawText("--------------------------------------------------", int32(m.X)+60, int32(m.Y)+110, 20, rl.Gray)

			y := int32(140)
			for _, res := range results {
				rl.DrawText(res, int32(m.X)+60, int32(m.Y)+y, 20, rl.Green)
				y += 30
			}

			rl.DrawText("--------------------------------------------------", int32(m.X)+60, int32(m.Y)+y, 20, rl.Gray)
			rl.DrawText("Results saved to bench.log.", int32(m.X)+60, int32(m.Y)+y+30, 18, rl.LightGray)
			rl.DrawText("Press any key to exit.", int32(m.X)+60, int32(m.Y)+y+60, 18, rl.Yellow)
		}

		rl.EndDrawing()
		if rl.GetKeyPressed() != 0 {
			break
		}
	}
}

// setupSceneForTrace mirrors the story-day / raft / tide / island positioning
// that storyPlay() would apply for a given (ADS, tag), so test and trace runs
// match real playback. Returns the normalized ADS name ("X.ADS"). Extracted
// from runTestMode so -traceserver can re-apply it per scene.
func setupSceneForTrace(adsName string, tagNo int) string {
	storyCurrentDay = activeConfig.CurrentDay
	islandState.xPos = 0
	islandState.yPos = 0
	islandState.lowTide = 0
	islandState.raft = 0

	var scene TStoryScene
	found := false
	if adsName != "" && tagNo > 0 {
		adsName = strings.ToUpper(adsName)
		if !strings.HasSuffix(adsName, ".ADS") {
			adsName += ".ADS"
		}

		for _, s := range storyScenes {
			if strings.ToUpper(s.adsName) == adsName && int(s.adsTagNo) == tagNo {
				scene = s
				found = true
				break
			}
		}

		if found {
			if scene.dayNo != 0 {
				storyCurrentDay = scene.dayNo
			}
			storyCalculateIslandFromScene(&scene)
			if scene.flags&ISLAND == ISLAND {
				xOffset := 0
				if scene.flags&LEFT_ISLAND == LEFT_ISLAND {
					xOffset = 272
				}
				ttmDx = islandState.xPos + xOffset
				ttmDy = islandState.yPos
			} else {
				ttmDx = 0
				ttmDy = 0
			}
		} else {
			islandState.xPos = 0
			islandState.yPos = 0
			islandState.lowTide = 0
			islandState.raft = 0
			ttmDx = 0
			ttmDy = 0
		}
	}

	// r.c. - previously called unconditionally, which meant testing any
	// non-ISLAND FINAL scene (JOHNNY.ADS tag 1 "The End", tag 6) via -t
	// always started the background wave thread and clouds thread even
	// though those scenes' own TTM scripts never draw either one, and
	// storyPlay() would never call adsInitIsland() for them either. Mirror
	// storyPlay()'s own choice here so test mode matches real playback.
	if !found || scene.flags&ISLAND == ISLAND {
		adsInitIsland()
	} else {
		adsNoIsland()
	}
	return adsName
}

func runTestMode(testAdsName string, testTagNo int) {
	setupApp()
	defer rl.CloseWindow()
	defer rl.CloseAudioDevice()
	defer graphicsEnd()
	defer unloadSfx()

	adsInit()
	testAdsName = setupSceneForTrace(testAdsName, testTagNo)

	if testAdsName != "" && testTagNo > 0 {
		fmt.Printf("Running custom test mode for scene: %s tag %d (LEFT_ISLAND=%v, xPos=%d)\n", testAdsName, testTagNo, islandState.xPos == -272, islandState.xPos)
		for !shouldExitApp {
			adsPlay(testAdsName, uint16(testTagNo))
			if traceReachedBudget {
				traceClose()
				os.Exit(0) // -trace: done emitting frames
			}
		}
	} else {
		for !shouldExitApp {
			// Play tree climb and dive (ACTIVITY.ADS tag 4)
			adsPlay("ACTIVITY.ADS", 4)
			if shouldExitApp {
				break
			}
			// Play water return (JOHNNY.ADS tag 3)
			adsPlay("JOHNNY.ADS", 3)
		}
	}
}

// runTraceServer inits raylib once, then serves scene traces on demand: read
// "ADS tag [frames]" lines from stdin, emit a delimited trace block per line to
// stdout. Amortizes the ~2s per-process raylib/GL startup across the whole
// oracle sweep. Each scene is reset to fresh-process state (traceResetForScene
// re-seeds the RNG) so the output matches the one-process-per-scene baseline
// bit-for-bit. Protocol per scene:
//
//	===TRACE ADS tag===
//	<canonical trace lines>
//	===END===
//
// Empty/blank input line or EOF ends the server.
func runTraceServer() {
	setupApp()
	defer rl.CloseWindow()
	defer rl.CloseAudioDevice()
	defer graphicsEnd()
	defer unloadSfx()

	adsInit()

	// Startup log lines land on stderr; stdout carries only trace blocks so the
	// harness can read them cleanly. Signal readiness so the harness can sync.
	fmt.Fprintln(os.Stderr, "[traceserver] ready")

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	out := bufio.NewWriter(os.Stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			break
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			fmt.Fprintf(os.Stderr, "[traceserver] bad request: %q\n", line)
			continue
		}
		ads := fields[0]
		tag := 0
		frames := 120
		fmt.Sscanf(fields[1], "%d", &tag)
		if len(fields) >= 3 {
			fmt.Sscanf(fields[2], "%d", &frames)
		}

		// Fresh-process state for this scene, then capture its trace to a buffer.
		// adsInit() zeroes every thread + the background/clouds/holiday threads
		// and numThreads — the same clean slate a freshly-launched process gets
		// (runTestMode calls it once per invocation). Without it, thread state
		// (e.g. the wave/clouds threads) leaks between scenes.
		adsInit()
		traceResetForScene()
		traceMaxFrame = frames
		shouldExitApp = false
		var buf bytes.Buffer
		traceOut = &buf

		adsName := setupSceneForTrace(ads, tag)
		// Mirror runTestMode's loop EXACTLY: some scenes (e.g. STAND.ADS tag 14)
		// end their ADS chunk after one frame but re-enter to keep animating, so
		// a single adsPlay returns early. Re-run until the frame budget is hit,
		// matching the one-process-per-scene baseline. Guard against a scene that
		// emits zero frames per call (would spin forever) by bailing if the trace
		// stops growing.
		for !traceReachedBudget && !shouldExitApp {
			before := buf.Len()
			adsPlay(adsName, uint16(tag))
			if buf.Len() == before {
				break // no progress this pass — scene produced nothing, avoid a spin
			}
		}

		traceOut = os.Stdout
		fmt.Fprintf(out, "===TRACE %s %d===\n", adsName, tag)
		out.Write(buf.Bytes())
		fmt.Fprintln(out, "===END===")
		out.Flush()
	}
}

func openURL(url string) {
	var err error
	switch runtime.GOOS {
	case "windows":
		err = exec.Command("cmd", "/c", "start", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	default: // "linux", etc.
		err = exec.Command("xdg-open", url).Start()
	}
	if err != nil {
		fmt.Println("failed to open URL: ", err)
	}
}
