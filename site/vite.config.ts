import { defineConfig } from "vite"

// Served at https://baiqiaozhang.cc/memosync/ ; SITE_BASE overrides the path.
export default defineConfig({
  base: process.env.SITE_BASE ?? "/memosync/",
  server: { port: 4410, fs: { allow: [".."] } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
})
