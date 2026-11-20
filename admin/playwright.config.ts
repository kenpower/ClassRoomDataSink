import { defineConfig } from '@playwright/test';

// Runs against a running stack (e.g. `docker compose up`), default http://localhost:8080.
// The stack must be started with AUTH_JWT_SECRET=$E2E_STARS_SECRET and STAFF_EMAIL_DOMAINS including setu.ie.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
