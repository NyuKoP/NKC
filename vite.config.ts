import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";

const electronBuild = {
  outDir: "dist-electron",
  sourcemap: true,
  emptyOutDir: false,
  rollupOptions: {
    external: ["electron"],
    output: {
      format: "cjs" as const,
      entryFileNames: "[name].js",
    },
  },
} satisfies import("vite").BuildOptions;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),

    electron([
      // =========================
      // main process
      // =========================
      {
        entry: "src/main.ts",
        onstart({ startup }) {
          void startup(["."]);
        },
        vite: {
          build: {
            ...electronBuild,
          },
        },
      },

      // =========================
      // preload process
      // =========================
      {
        entry: "src/preload.ts",
        vite: {
          build: {
            ...electronBuild,
          },
        },
      },
    ]),
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
});
