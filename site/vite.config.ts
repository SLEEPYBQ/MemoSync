import { defineConfig } from "vite"

// Served at https://memosync.cc/ ; SITE_BASE overrides the path.
export default defineConfig({
  base: process.env.SITE_BASE ?? "/",
  server: { port: 4410, fs: { allow: [".."] } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
})
