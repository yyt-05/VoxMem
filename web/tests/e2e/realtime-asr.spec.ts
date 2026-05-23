import { expect, test } from '@playwright/test';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const zh = {
  apiConnected: '\u0041\u0050\u0049 \u5df2\u8fde\u63a5',
  start: '\u5f00\u59cb',
  recording: '\u5f55\u97f3\u4e2d',
  runtimeStatus: '\u8fd0\u884c\u72b6\u6001',
  stop: '\u505c\u6b62',
  completed: '\u5df2\u5b8c\u6210',
  finalOutputText: '\u6700\u7ec8\u8f93\u51fa\u6587\u672c',
  errorPrefix: '\u9519\u8bef\uff1a',
};

const audioDebugDir = path.resolve('../tmp/e2e-audio-debug');

test('runs the mock realtime ASR recording flow', async ({ page, context }) => {
  await context.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:5175' });
  await rm(audioDebugDir, { force: true, recursive: true });

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/');

  await expect(page.getByText(zh.apiConnected)).toBeVisible();
  await expect(page.getByText('voxmem-api')).toBeVisible();

  const startButton = page.getByRole('button', { name: zh.start });
  await expect(startButton).toBeEnabled();
  await startButton.click();

  const stopButton = page.getByRole('button', { name: zh.stop });
  await expect(stopButton).toBeVisible();
  await expect(page.getByLabel(zh.runtimeStatus).getByText(zh.recording)).toBeVisible();
  await expect(page.getByText('mock-task-')).toBeVisible();

  await page.waitForTimeout(750);

  await expect(stopButton).toBeEnabled();
  await stopButton.click();

  await expect(page.getByLabel(zh.runtimeStatus).getByText(zh.completed)).toBeVisible();
  await expect(page.getByLabel(zh.finalOutputText)).toHaveValue(/mock final text/);
  await expect(page.getByText(zh.errorPrefix)).toHaveCount(0);
  await expect.poll(async () => {
    const files = await readdir(audioDebugDir);
    const wavFiles = files.filter((file) => file.endsWith('.wav'));
    if (wavFiles.length === 0) {
      return 0;
    }
    const wav = await stat(path.join(audioDebugDir, wavFiles[0]));
    return wav.size;
  }).toBeGreaterThan(44);

  const unexpectedErrors = consoleErrors.filter((error) => !error.includes('favicon'));
  expect(unexpectedErrors).toEqual([]);
});
