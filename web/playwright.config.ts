import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5185',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: [
    {
      command:
        'node -e "const path=require(\'path\'); process.env.VOXMEM_SERVER_ADDR=\':18085\'; process.env.VOXMEM_ASR_MODE=\'mock\'; process.env.VOXMEM_ALLOWED_ORIGINS=\'http://127.0.0.1:5185\'; process.env.VOXMEM_AUDIO_DEBUG_ENABLED=\'true\'; process.env.VOXMEM_AUDIO_DEBUG_DIR=\'../tmp/e2e-audio-debug\'; process.env.VOXMEM_DB_PATH=\'../tmp/e2e-voxmem.db\'; process.env.GOCACHE=path.resolve(\'../server/.gocache\'); const cmd = process.platform === \'win32\' ? \'go run .\\\\cmd\\\\server\' : \'go run ./cmd/server\'; require(\'child_process\').spawn(cmd, { cwd: \'../server\', shell: true, stdio: \'inherit\', env: process.env });"',
      url: 'http://127.0.0.1:18085/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        'node -e "process.env.VITE_API_BASE_URL=\'http://127.0.0.1:18085\'; require(\'child_process\').spawn(\'npm run dev -- --host 127.0.0.1 --port 5185\', { shell: true, stdio: \'inherit\', env: process.env });"',
      url: 'http://127.0.0.1:5185',
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
