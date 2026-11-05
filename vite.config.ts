import { defineConfig } from "vite";

// In dev, Rust starts PHP on a fixed port and Vite proxies /adminer to it so the UI and
// Adminer share one origin (otherwise the iframe's cookies are blocked).
const PHP_DEV_PORT = Number(process.env.ADRIX_DEV_PHP_PORT ?? 18765);

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/adminer": { target: `http://127.0.0.1:${PHP_DEV_PORT}`, changeOrigin: false },
    },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: ["es2022", "safari16"],
    outDir: "dist",
    emptyOutDir: true,
  },
});
