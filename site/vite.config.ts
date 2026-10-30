import { defineConfig } from "vite"

// Served at the root of https://memosync.baiqiaozhang.cc/ ; SITE_BASE overrides it.
export default defineConfig({
  base: process.env.SITE_BASE ?? "/",
  server: { port: 4410, fs: { allow: [".."] } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
})
