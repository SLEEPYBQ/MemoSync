import { defineConfig } from "vite"

// Served from https://sleepybq.github.io/MemoSync/ ; override with SITE_BASE for a custom domain.
export default defineConfig({
  base: process.env.SITE_BASE ?? "/MemoSync/",
  server: { port: 4410, fs: { allow: [".."] } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
})
