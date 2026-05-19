import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // clearMocks resets call history between tests but preserves the
    // implementations defined in vi.mock factories (unlike restoreMocks).
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["src/lib/types.ts"],
    },
  },
});
