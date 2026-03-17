import path from "node:path";

import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const apiOrigin = process.env.FOREMAN_API_ORIGIN ?? "http://127.0.0.1:8765";

export default defineConfig({
  root: "ui",
  plugins: [svelte()],
  css: {
    postcss: path.resolve("ui"),
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": apiOrigin,
    },
  },
  build: {
    outDir: path.resolve("dist/ui"),
    emptyOutDir: false,
  },
});
