import { defineConfig } from "vite";

// The slice serves the pre-extracted animation assets from public/anim.
// base is relative so a `vite build` can be dropped under any sub-path
// (e.g. GitHub Pages) without rewriting asset URLs.
export default defineConfig({
  base: "./",
});
