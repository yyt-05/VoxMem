import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5175',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: [
    {
      command:
        'powershell -NoProfile -Command "$env:VOXMEM_SERVER_ADDR=\':18080\'; $env:VOXMEM_ASR_MODE=\'mock\'; $env:VOXMEM_ALLOWED_ORIGINS=\'http://127.0.0.1:5175\'; $env:VOXMEM_AUDIO_DEBUG_ENABLED=\'true\'; $env:VOXMEM_AUDIO_DEBUG_DIR=\'..\\tmp\\e2e-audio-debug\'; $env:VOXMEM_DB_PATH=\'..\\tmp\\e2e-voxmem.db\'; Set-Location ..\\server; go run .\\cmd\\server"',
      url: 'http://127.0.0.1:18080/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        'powershell -NoProfile -Command "$env:VITE_API_BASE_URL=\'http://127.0.0.1:18080\'; npm run dev -- --host 127.0.0.1 --port 5175"',
      url: 'http://127.0.0.1:5175',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
