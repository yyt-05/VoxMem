import { expect, test } from '@playwright/test';

test('runs the mock realtime ASR recording flow', async ({ page, context }) => {
  await context.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:5175' });

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/');

  await expect(page.getByText('API 已连接')).toBeVisible();
  await expect(page.getByText('voxmem-api')).toBeVisible();

  const startButton = page.getByRole('button', { name: '开始' });
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(page.getByRole('button', { name: '录音中' })).toBeVisible();
  await expect(page.getByLabel('运行状态').getByText('录音中')).toBeVisible();
  await expect(page.getByText('mock-task-')).toBeVisible();

  await page.waitForTimeout(750);

  const stopButton = page.getByRole('button', { name: '停止' });
  await expect(stopButton).toBeEnabled();
  await stopButton.click();

  await expect(page.getByLabel('运行状态').getByText('已完成')).toBeVisible();
  await expect(page.getByLabel('最终输出文本')).toHaveValue(/今天下午确认接口方案。/);
  await expect(page.getByText('错误：')).toHaveCount(0);

  const unexpectedErrors = consoleErrors.filter((error) => !error.includes('favicon'));
  expect(unexpectedErrors).toEqual([]);
});
