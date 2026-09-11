import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:5185', launchOptions: { executablePath: process.env.CHROME_PATH || undefined } },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5185 --strictPort', url: 'http://127.0.0.1:5185', reuseExistingServer: !process.env.CI },
});
