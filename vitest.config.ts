import { defineConfig } from 'vitest/config'

// The optional `wechat/` bridge has its own tests and runs from its own directory, not from this
// package's suite.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: ['node_modules/**', 'wechat/**'],
  },
})
