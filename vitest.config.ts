import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost:3000",
      },
    },
    globals: false,
    setupFiles: ["./test/setup.ts"],
  },
})
