import { defineConfig } from '@playwright/test'

// Functional browser cases share a loopback IP and a local model stub. Rate
// enforcement is covered separately; don't make these cases compete for quota.
const testLimits = {
  API_HOSTS: '127.0.0.1:19091',
  IP_RPM: '60000',
  HOST_RPM: '60000',
  GLOBAL_RPM: '60000',
  IP_CONCURRENCY: '32',
  HOST_CONCURRENCY: '32',
  MAX_CONCURRENT_REQUESTS: '32',
  TRUSTED_PROXIES: '',
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    locale: 'zh-CN',
    colorScheme: 'light',
    baseURL: 'http://127.0.0.1:19090',
    viewport: { width: 1440, height: 1024 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: 'list',
  webServer: [
    {
      command: 'node tests/mock-provider.mjs',
      url: 'http://127.0.0.1:19091/health',
      reuseExistingServer: false,
    },
    {
      command: '../bin/muyu',
      url: 'http://127.0.0.1:19090/api/health',
      // Existing interaction cases use the explicit Chinese deployment default.
      env: { ...testLimits, ADDR: '127.0.0.1:19090', ALLOW_PRIVATE_UPSTREAMS: 'true', UI_LANG: 'zh-CN' },
      reuseExistingServer: false,
    },
    {
      command: '../bin/muyu',
      url: 'http://127.0.0.1:19092/api/health',
      // An empty override exercises the program's English fallback.
      env: { ...testLimits, ADDR: '127.0.0.1:19092', UI_LANG: '' },
      reuseExistingServer: false,
    },
  ],
})
