import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Coverage thresholds only apply to the two diff engines the review UI leans
 * on: a regression there silently corrupts +N/−N badges and diffs everywhere.
 * The rest of the repo is measured but not gated.
 */
const DIFF_GLOBS = ["src/lib/diff.ts", "src/lib/git-diff.ts"];
const MIN_80 = { lines: 80, functions: 80, branches: 80, statements: 80 };

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/lib/**"],
      all: false,
      thresholds: {
        // Per-file glob thresholds (vitest >= 2.1): gate each diff file at 80%.
        ...Object.fromEntries(DIFF_GLOBS.map((g) => [g, MIN_80])),
      },
    },
  },
});
