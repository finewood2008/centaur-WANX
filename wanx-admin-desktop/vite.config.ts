import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { collectLicenses } from "./tools/licenses.mjs";
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "third-party-licenses",
      async generateBundle(_options, bundle) {
        const modules = Object.values(bundle).flatMap((chunk) =>
          chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
        );
        this.emitFile({
          type: "asset",
          fileName: "third-party-licenses.json",
          source: JSON.stringify(await collectLicenses(modules), null, 2),
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: { maxParallelFileOps: 3 },
  },
});
