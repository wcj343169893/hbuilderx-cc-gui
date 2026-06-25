'use strict';

const { defineConfig, devices } = require('@playwright/test');

/**
 * CC GUI webview 无头端到端测试配置。
 * 跑的是真实发布产物 hbuilderx-plugin/html/claude-chat.html + 真实桥接/装配器，仅 mock daemon stdout。
 */
module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    headless: true,
    actionTimeout: 8_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
