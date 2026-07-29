//go:build windows

package main

import "syscall"

// On Windows the screensaver polls global key state via user32!GetAsyncKeyState
// so hotkeys (pause, speed, step, quit) respond even when the window is not the
// foreground window. See graphics.go for the callers.
var (
	modUser32            = syscall.NewLazyDLL("user32.dll")
	procGetAsyncKeyState = modUser32.NewProc("GetAsyncKeyState")
)

func isKeyDownGlobally(vk int) bool {
	r, _, _ := procGetAsyncKeyState.Call(uintptr(vk))
	return (r & 0x8000) != 0
}

func isAnyKeyPressedGlobally() bool {
	for vk := 8; vk <= 255; vk++ {
		if isKeyDownGlobally(vk) {
			return true
		}
	}
	return false
}
