import { expect, test } from '@playwright/test';

test('welcome source selectors search, preserve selected IDs, and show bot avatars', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=setup-welcome-cleanup--unconfigured&viewMode=story');
  await expect(
    page.getByRole('checkbox', { name: 'Delete welcome messages after bans' })
  ).toBeChecked();
  await page.locator('summary').filter({ hasText: 'Choose welcome bot' }).click();
  await page.getByRole('searchbox', { name: 'Search welcome bot' }).fill('helper');
  const bot = page.getByRole('button', { name: 'Community Helper @helper' });
  await expect(bot.locator('img')).toHaveAttribute('src', /avatars\/1.png/);
  await expect(page.getByRole('button', { name: 'Welcome Bot @welcome' })).toHaveCount(0);
  await bot.click();
  await expect(page.locator('input[name="welcomeCleanupBotId"]')).toHaveValue('123456789012345679');
  await page.locator('summary').filter({ hasText: 'Choose welcome channel' }).click();
  await page.getByRole('searchbox', { name: 'Search welcome channel' }).fill('intro');
  await page.getByRole('button', { name: '#introductions', exact: true }).click();
  await expect(page.locator('input[name="welcomeCleanupChannelId"]')).toHaveValue(
    '234567890123456780'
  );
  await page.getByRole('checkbox').uncheck();
  await expect(page.locator('input[name="welcomeCleanupBotId"]')).toHaveValue('123456789012345679');
  await expect(page.locator('input[name="welcomeCleanupChannelId"]')).toHaveValue(
    '234567890123456780'
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'storybook-test-results/welcome-cleanup-mobile.png' });
});

test('unavailable bot lists preserve saved configuration', async ({ page }) => {
  await page.goto('/iframe.html?id=setup-welcome-cleanup--unavailable&viewMode=story');
  await expect(page.getByRole('status')).toContainText('saved selection is preserved');
  await expect(page.locator('input[name="welcomeCleanupBotId"]')).toHaveValue('123456789012345678');
});

test('bot typeahead finds bots outside the initial known-role list', async ({ page }) => {
  await page.goto('/iframe.html?id=setup-welcome-cleanup--bot-search&viewMode=story');
  await page.locator('summary').filter({ hasText: 'Choose welcome bot' }).click();
  await page.getByRole('searchbox', { name: 'Search welcome bot' }).fill('other');
  await page.getByRole('button', { name: 'Other Bot @other' }).click();
  await expect(page.locator('input[name="welcomeCleanupBotId"]')).toHaveValue('123456789012345670');
});
