import { expect, type Page, test } from '@playwright/test';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const zh = {
  apiConnected: '\u0041\u0050\u0049 \u5df2\u8fde\u63a5',
  enterWorkspace: '\u8fdb\u5165\u8bed\u97f3\u5de5\u4f5c\u53f0',
  startRecording: '\u5f00\u59cb',
  stopRecording: '\u505c\u6b62',
  listening: '\u6b63\u5728\u542c\u5199',
  completed: '\u5df2\u5b8c\u6210',
  inputText: '\u8f93\u5165\u6587\u672c',
  errorPrefix: '\u9519\u8bef\uff1a',
  voiceWave: '\u97f3\u6ce2',
  raw: '\u539f\u58f0',
  polish: '\u8f7b\u6574\u7406',
  markdown: 'Markdown',
  hotwordMemory: '\u672c\u5730\u8bb0\u5fc6',
  hotwordManager: '\u70ed\u8bcd\u7ba1\u7406',
  voiceFilter: '\u53bb\u9664\u5468\u56f4\u4eba\u58f0',
  showAll: '\u663e\u793a\u5168\u90e8',
};

const audioDebugDir = path.resolve('../tmp/e2e-audio-debug');

async function openWorkspace(page: Page) {
  await page.goto('/');
  await page.locator('.intro-hero .intro-primary').click();
  await expect(page.getByText(zh.apiConnected)).toBeVisible();
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:5185' });
  await rm(audioDebugDir, { force: true, recursive: true });
});

test('runs the mock realtime ASR recording flow from the workspace', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await openWorkspace(page);

  const modePanel = page.locator('.mode-stack');
  const rawButton = modePanel.getByRole('button', { name: new RegExp(`^${zh.raw}`) });
  const polishButton = modePanel.getByRole('button', { name: new RegExp(`^${zh.polish}`) });

  await expect(rawButton).toBeVisible();
  await expect(polishButton).toBeVisible();

  await rawButton.click();
  await expect(rawButton).toHaveClass(/active/);
  await polishButton.click();
  await expect(polishButton).toHaveClass(/active/);
  await rawButton.click();

  const startButton = page.getByRole('button', { name: zh.startRecording });
  await expect(startButton).toBeEnabled();
  await startButton.click();

  await expect(page.getByRole('button', { name: zh.stopRecording })).toBeVisible();
  await expect(page.getByText(zh.listening)).toBeVisible();
  await expect(page.getByLabel(zh.voiceWave)).toBeVisible();
  await expect(page.getByText(/mock final text/)).toBeVisible();

  await page.waitForTimeout(750);

  await page.getByRole('button', { name: zh.stopRecording }).click();

  await expect(page.getByText(zh.completed)).toBeVisible();
  await expect(page.getByLabel(zh.inputText)).toHaveValue(/mock final text/);
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

test('shows learned local memory for the current user', async ({ page }) => {
  const userID = `e2e-memory-${Date.now()}`;
  await page.addInitScript((id) => {
    localStorage.setItem('voxmem_user_id', id);
  }, userID);

  const response = await page.request.post('http://127.0.0.1:18085/api/input/commit', {
    data: {
      user_id: userID,
      session_id: 'e2e-session',
      mode: 'raw',
      original_text: '\u4eca\u5929\u627e\u5f20\u529b\u786e\u8ba4\u65b9\u6848',
      enhanced_text: '\u4eca\u5929\u627e\u5f20\u529b\u786e\u8ba4\u65b9\u6848',
      final_text: '\u4eca\u5929\u627e\u5f20\u7acb\u786e\u8ba4\u65b9\u6848',
      learn_hotwords: true,
      manual_edit_base: '\u4eca\u5929\u627e\u5f20\u529b\u786e\u8ba4\u65b9\u6848',
    },
  });
  expect(response.ok()).toBeTruthy();

  await openWorkspace(page);
  await page.locator('.topbar-actions .ghost-button').filter({ hasText: zh.hotwordManager }).click();

  const dialog = page.getByRole('dialog', { name: zh.hotwordMemory });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('\u5f20\u529b -> \u5f20\u7acb')).toBeVisible();
});

test('learns hotwords only after a manual edit to automatic output', async ({ page }) => {
  const commitBodies: Array<Record<string, unknown>> = [];

  await page.route('http://127.0.0.1:18085/api/input/commit', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commitBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        text: body.final_text,
        mode: body.mode,
        source: 'local',
        latency_ms: 1,
        mappings: [],
      }),
    });
  });

  await openWorkspace(page);
  await page.locator('.mode-stack').getByRole('button', { name: new RegExp(`^${zh.raw}`) }).click();
  await page.getByRole('button', { name: zh.startRecording }).click();
  await page.getByRole('button', { name: zh.stopRecording }).waitFor();
  await page.waitForTimeout(750);
  await page.getByRole('button', { name: zh.stopRecording }).click();

  const input = page.getByLabel(zh.inputText);
  await expect(input).toHaveValue(/mock final text/);
  const automaticOutput = await input.inputValue();

  await page.getByRole('button', { name: '\u786e\u8ba4' }).click();
  await expect.poll(() => commitBodies.length).toBe(1);
  expect(commitBodies[0].learn_hotwords).toBe(false);
  expect(commitBodies[0]).not.toHaveProperty('manual_edit_base');

  await input.fill(`${automaticOutput} corrected`);
  await input.blur();
  await expect.poll(() => commitBodies.length).toBe(2);
  expect(commitBodies[1].learn_hotwords).toBe(true);
  expect(commitBodies[1].manual_edit_base).toBe(automaticOutput);
});

test('filters file transcription to the first detected speaker and can restore all text', async ({ page }) => {
  await page.route('http://127.0.0.1:18085/api/transcribe/file', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        full_text: '\u672c\u4eba\u7b2c\u4e00\u53e5\u3002\u65c1\u4eba\u63d2\u8bdd\u3002\u672c\u4eba\u7b2c\u4e8c\u53e5\u3002',
        speaker_count: 2,
        sentences: [
          { speaker_id: 1, text: '\u672c\u4eba\u7b2c\u4e00\u53e5\u3002' },
          { speaker_id: 2, text: '\u65c1\u4eba\u63d2\u8bdd\u3002' },
          { speaker_id: 1, text: '\u672c\u4eba\u7b2c\u4e8c\u53e5\u3002' },
        ],
      }),
    });
  });

  await openWorkspace(page);
  await page.locator('.mode-stack').getByRole('button', { name: new RegExp(`^${zh.raw}`) }).click();
  await page.locator('.voice-processing-card .voice-option input[type="checkbox"]').check({ force: true });
  await page.getByRole('button', { name: zh.startRecording }).click();
  await page.getByRole('button', { name: zh.stopRecording }).waitFor();
  await page.waitForTimeout(750);
  await page.getByRole('button', { name: zh.stopRecording }).click();

  await expect(page.getByLabel(zh.inputText)).toHaveValue('\u672c\u4eba\u7b2c\u4e00\u53e5\u3002\u672c\u4eba\u7b2c\u4e8c\u53e5\u3002');
  await expect(page.getByLabel(zh.inputText)).not.toHaveValue(/旁人插话/);

  await page.getByRole('button', { name: zh.showAll }).click();
  await expect(page.getByLabel(zh.inputText)).toHaveValue('\u672c\u4eba\u7b2c\u4e00\u53e5\u3002\u65c1\u4eba\u63d2\u8bdd\u3002\u672c\u4eba\u7b2c\u4e8c\u53e5\u3002');
});

test.skip('keeps realtime draft visible while voice filter chunk transcription runs', async ({ page }) => {
  const fileRequests: number[] = [];

  await page.route('http://127.0.0.1:18085/api/transcribe/file', async (route) => {
    fileRequests.push(route.request().postDataBuffer()?.byteLength ?? 0);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        full_text: '\u672c\u4eba\u5206\u7247\u3002\u65c1\u4eba\u5206\u7247\u3002',
        speaker_count: 2,
        sentences: [
          { speaker_id: 1, text: '\u672c\u4eba\u5206\u7247\u3002' },
          { speaker_id: 2, text: '\u65c1\u4eba\u5206\u7247\u3002' },
        ],
      }),
    });
  });

  await openWorkspace(page);
  await page.locator('.mode-stack').getByRole('button', { name: new RegExp(`^${zh.raw}`) }).click();
  await page.locator('.voice-processing-card .voice-option input[type="checkbox"]').check({ force: true });
  await page.getByRole('button', { name: zh.startRecording }).click();
  await page.getByRole('button', { name: zh.stopRecording }).waitFor();
  await page.waitForTimeout(4500);

  await expect.poll(() => fileRequests.length, { timeout: 7000 }).toBeGreaterThan(0);
  await expect(page.getByLabel(zh.inputText)).toHaveValue(/\u672c\u4eba\u5206\u7247/);

  await page.getByRole('button', { name: zh.stopRecording }).click();
  await expect(page.getByText(zh.completed)).toBeVisible();
});
