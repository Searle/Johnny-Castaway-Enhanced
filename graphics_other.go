//go:build !windows

package main

import (
	rl "github.com/gen2brain/raylib-go/raylib"
)

// Non-Windows platforms have no global key polling equivalent that is portable,
// so hotkeys fall back to raylib's in-window key state. The callers use Windows
// virtual-key codes; map the ones actually used to raylib keys.
var vkToRaylib = map[int]int32{
	0x10: rl.KeyLeftShift, // VK_SHIFT
	0x20: rl.KeySpace,     // VK_SPACE
	0x4D: rl.KeyM,         // VK_M
	0x0D: rl.KeyEnter,     // VK_RETURN
	0x1B: rl.KeyEscape,    // VK_ESCAPE
}

func isKeyDownGlobally(vk int) bool {
	if key, ok := vkToRaylib[vk]; ok {
		return rl.IsKeyDown(key)
	}
	return false
}

func isAnyKeyPressedGlobally() bool {
	return rl.GetKeyPressed() != 0
}
