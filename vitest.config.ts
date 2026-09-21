import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    // Live tests hit a shared public Base RPC. Running test files in parallel
    // makes them throttle each other, which shows up as unrelated failures.
    // File-level isolation, no concurrency, keeps the live suite honest.
    fileParallelism: false,
    poolOptions: { threads: { singleThread: true } },
  },
});