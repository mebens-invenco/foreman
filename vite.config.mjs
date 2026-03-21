import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const apiOrigin = process.env.FOREMAN_API_ORIGIN ?? "http://127.0.0.1:8765";

export default defineConfig({
  root: "ui",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve("ui/src"),
    },
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
