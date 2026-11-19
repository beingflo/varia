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
  webServer: {
    command: 'npx vite --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
