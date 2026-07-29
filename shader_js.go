//go:build js

package main

import (
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"
)

// The fork's raylib runtime creates a WebGL1 context (GLSL ES 1.00), so the
// shader bodies — written in desktop GLSL 3.30 style (in/out/texture()) — are
// translated to ES 1.00 at load time: `#version 100` + precision, `in`
// varyings become `varying`, the `out vec4 finalColor;` declaration is dropped
// and finalColor writes go to gl_FragColor, and texture() becomes texture2D().
// See shader_other.go for the desktop path (no translation).
const fsPrelude = "#version 100\nprecision highp float;\nprecision highp int;\n"

// On the web build an empty vertex-shader string is not substituted with
// raylib's default (as it is on desktop); it reaches GL as empty source and
// fails to compile. Supply raylib's standard GLSL 100 default vertex shader
// explicitly. It matches the attribute/uniform/varying names raylib binds.
const defaultVsES100 = `#version 100
attribute vec3 vertexPosition;
attribute vec2 vertexTexCoord;
attribute vec4 vertexColor;
uniform mat4 mvp;
varying vec2 fragTexCoord;
varying vec4 fragColor;
void main() {
    fragTexCoord = vertexTexCoord;
    fragColor = vertexColor;
    gl_Position = mvp * vec4(vertexPosition, 1.0);
}`

func loadFsShader(body string) rl.Shader {
	src := body
	src = strings.ReplaceAll(src, "out vec4 finalColor;", "")
	src = strings.ReplaceAll(src, "finalColor", "gl_FragColor")
	src = strings.ReplaceAll(src, "in vec2 ", "varying vec2 ")
	src = strings.ReplaceAll(src, "in vec4 ", "varying vec4 ")
	src = strings.ReplaceAll(src, "texture(", "texture2D(")
	return rl.LoadShaderFromMemory(defaultVsES100, fsPrelude+src)
}
