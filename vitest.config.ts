import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "ui/src/**/__tests__/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
