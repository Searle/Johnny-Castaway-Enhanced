//go:build linux

package main

import (
	"os"
	"strings"
	"syscall"
)

// preferX11Backend nudges GLFW toward the X11 (XWayland) backend on Linux.
//
// This raylib build links GLFW with both the X11 and Wayland backends. When
// XDG_SESSION_TYPE is unset (as under WSLg), GLFW auto-detects in array order
// and Wayland wins. The native Wayland path can fail to present the window (a
// black window even though rendering succeeds), which is especially common
// under WSLg. When an X11 display is available (XWayland always provides one
// under WSLg and on most Wayland desktops), force the well-tested X11 backend
// by setting XDG_SESSION_TYPE=x11, which GLFW's _glfwSelectPlatform honors.
//
// GLFW is a C library and reads these vars from the C runtime's own copy of
// the environment, which Go's os.Setenv does not update. The reliable way to
// hand GLFW a modified environment is to re-exec this process once. A guard
// variable prevents an exec loop.
//
// Must be called before the first rl.InitWindow. No-op when there is no X11
// display, or when a Wayland session is explicitly declared, so it never
// breaks a system that should use Wayland. Set JOHNNY_FORCE_WAYLAND to keep
// the native Wayland backend.
func preferX11Backend() {
	if os.Getenv("JOHNNY_X11_REEXEC") != "" {
		return // already re-exec'd once; avoid a loop
	}
	if os.Getenv("JOHNNY_FORCE_WAYLAND") != "" {
		return
	}
	if os.Getenv("DISPLAY") == "" {
		return // no X11 display available; leave GLFW to pick Wayland
	}
	// Respect an explicit Wayland session declaration.
	if os.Getenv("XDG_SESSION_TYPE") == "wayland" {
		return
	}

	// Rebuild the environment: force X11 session type, drop WAYLAND_DISPLAY,
	// and set the re-exec guard.
	env := os.Environ()
	cleaned := make([]string, 0, len(env)+2)
	for _, kv := range env {
		if strings.HasPrefix(kv, "WAYLAND_DISPLAY=") || strings.HasPrefix(kv, "XDG_SESSION_TYPE=") {
			continue
		}
		cleaned = append(cleaned, kv)
	}
	cleaned = append(cleaned, "XDG_SESSION_TYPE=x11", "JOHNNY_X11_REEXEC=1")

	exe, err := os.Executable()
	if err != nil {
		return // fall back to whatever backend GLFW picks
	}
	// syscall.Exec replaces the current process image, so control never
	// returns on success; on failure we continue with the current backend.
	_ = syscall.Exec(exe, os.Args, cleaned)
}
