import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  // Buffer/process polyfills are needed by @solana/web3.js and Anchor in the browser.
  plugins: [react(), nodePolyfills({ include: ["buffer", "process", "crypto", "stream", "util"], globals: { Buffer: true, process: true } })],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/api": { target: "http://localhost:3000" },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
