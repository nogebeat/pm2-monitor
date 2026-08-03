import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Le serveur Express (server.js) sert le dossier ../public en statique et
// expose l'API REST + WebSocket sur le même port (4200 par défaut).
// En dev, Vite tourne sur son propre port et proxifie /api + /socket.io
// vers ce serveur pour profiter du hot-reload sans dupliquer la logique.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4200",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:4200",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    sourcemap: false,
  },
});
