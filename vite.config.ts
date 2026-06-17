import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port and ignores its own source tree.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Prevent Vite from obscuring Rust errors in the terminal.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // The Rust side is rebuilt by Tauri, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce a lean bundle; targets match the WebViews Tauri ships against.
  build: {
    target: ["es2021", "chrome105", "safari13"],
    minify: "esbuild",
    sourcemap: false,
  },
});
