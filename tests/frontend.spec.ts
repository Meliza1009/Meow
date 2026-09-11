import { test, expect } from '@playwright/test';

test('demo responds to dragging and extracts on release, without a timer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#enterMachine')).toBeVisible();
  await page.clock.runFor(16000);
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'standing');
  const rail = await page.locator('#demoHandle').boundingBox();
  if (!rail) throw new Error('Missing compression handle');
  await page.mouse.move(rail.x + rail.width / 2, rail.y + 25);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height * .55, { steps: 5 });
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'crouching');
  await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height - 25, { steps: 5 });
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'zipped');
  await page.mouse.move(rail.x + 120, rail.y + rail.height);
  await page.mouse.up();
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'standing');
  await expect(page.locator('#demoStatus')).toContainText('Human restored');
  await page.locator('#demoHandle').focus();
  await page.keyboard.down('End');
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'zipped');
  await page.keyboard.up('End');
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'standing');
  await page.locator('#demoToggle').click();
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'zipped');
  await page.locator('#demoToggle').click();
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'standing');
  await page.locator('#enterMachine').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.reload();
  await expect(page.locator('#intro')).toBeHidden();
  await page.locator('#replayIntro').click();
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'standing');
  await page.locator('#skipIntro').click();
  await expect(page.locator('#app')).toBeVisible();
  expect(errors).toEqual([]);
});

test('reduced motion provides immediate entry and no automatic camera request', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Camera must not start during the intro'); };
  });
  await page.goto('/');
  await expect(page.locator('#intro')).toBeVisible();
  await page.locator('#enterMachine').click();
  await expect(page.locator('#warn')).toBeEmpty();
  await page.locator('[data-mode="personal-best"]').click();
  await expect(page.locator('#methods')).toBeHidden();
  await page.locator('[data-mode="classic"]').click();
  await page.locator('[data-m="comfortable"]').click();
  await expect(page.locator('#methodDesc')).toContainText('75%');
  await expect(page.locator('[data-m="comfortable"]')).toHaveAttribute('aria-pressed', 'true');
});

test('touch dragging zips, and cancellation safely extracts', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5185/');
  const rail = await page.locator('#demoHandle').boundingBox();
  if (!rail) throw new Error('Missing handle');
  const cdp = await context.newCDPSession(page);
  const x = rail.x + rail.width / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: rail.y + 25 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: rail.y + rail.height - 25 }] });
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'zipped');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('#demoMachine')).toHaveAttribute('data-pose', 'standing');
  await context.close();
});

for (const [width, height] of [[360, 800], [390, 844], [844, 390], [1366, 900]]) {
  test(`layout fits ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `/tmp/zip-demo-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#enterMachine').click();
    await page.locator('#name').fill('abcdefghijklmnopqrst');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Exercise presentation states without pretending to validate pose inference.
    await page.evaluate(() => {
      document.body.dataset.gameState = 'zipped';
      document.querySelector('#resultPanel')!.classList.remove('hidden');
      document.querySelector('#resultPhotos')!.classList.add('hidden');
      document.querySelector('#extractPanel')!.classList.remove('hidden');
    });
    await expect(page.locator('#btnExtract')).toBeVisible();
    await expect(page.locator('.terminal-panel')).not.toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
