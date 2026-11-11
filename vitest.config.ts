import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    env: {
      // Throwaway key for the test run only; never used for real data.
      APP_MASTER_KEY: '0cf8629572b19e7a35858ebbea944824ea92fe9d982f8e5f9d293dee3ab73bdc',
    },
  },
})
