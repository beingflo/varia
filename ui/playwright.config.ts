import { defineConfig, devices } from '@playwright/test';

// The app is only meaningful when cross-origin isolated, so tests run against a real server.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'dot' : 'list',
  use: { baseURL: 'http://localhost:4174', trace: 'retain-on-failure' },
  // VARIA_E2E_BROWSERS=chromium,firefox,webkit — chromium by default for speed.
  projects: (process.env.VARIA_E2E_BROWSERS ?? 'chromium').split(',').map((name) => {
    const device = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] }[name.trim()];
    if (!device) throw new Error(`unknown browser ${name}`);
    return { name: name.trim(), use: { ...device } };
  }),
  // The built app, not the dev server: no HMR reloads can land in the middle of a test.
  webServer: {
    command: 'npm run build && npx vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
