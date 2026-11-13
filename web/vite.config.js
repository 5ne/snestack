import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.SNESTACK_API || "http://127.0.0.1:4700";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: api,
        changeOrigin: true,
      },
    },
  },
});
