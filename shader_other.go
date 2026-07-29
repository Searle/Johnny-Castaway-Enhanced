//go:build !js

package main

import rl "github.com/gen2brain/raylib-go/raylib"

// shaderPrelude is prepended to each fragment-shader body. Desktop OpenGL uses
// GLSL 3.30 core. See shader_js.go for the WebGL (GLSL ES 3.00) variant.
const shaderPrelude = "#version 330\n"

func loadFsShader(body string) rl.Shader {
	return rl.LoadShaderFromMemory("", shaderPrelude+body)
}
