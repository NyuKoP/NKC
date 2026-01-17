import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      entry: "src/main.ts",
      vite: {
        build: {
          outDir: "dist-electron",
          sourcemap: true,
          rollupOptions: {
            external: ["electron"],
          },
        },
      },
      preload: {
        input: {
          preload: "src/preload.ts",
        },
        vite: {
          build: {
            outDir: "dist-electron",
            sourcemap: true,
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "libsodium-wrappers-sumo": path.resolve(
        __dirname,
        "node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js"
      ),
      "libsodium-sumo": path.resolve(
        __dirname,
        "node_modules/libsodium-sumo/dist/modules-sumo/libsodium-sumo.js"
      ),
    },
  },
  optimizeDeps: {
    include: ["libsodium-wrappers-sumo", "libsodium-sumo"],
  },
})
