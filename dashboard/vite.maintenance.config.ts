import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// A separate renderer entry. It never imports App, MainLayout or dashboard routes.
export default defineConfig({
  base: "/__wanx_tools/",
  plugins: [react()],
  publicDir: false,
  define: { BASE_URL: JSON.stringify("") },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      {
        find: "../../assets/mascot",
        replacement: path.resolve(__dirname, "src/maintenance/mascot.ts"),
      },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, "../wanx-client/local-ui/maintenance"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "maintenance.html"),
      maxParallelFileOps: 3,
    },
  },
});
