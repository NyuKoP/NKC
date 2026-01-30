import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
  test: {
    environment: "node",
    exclude: ["node_modules/**", "tests/ui/**"],
  },
});
