import { expect, test } from '@playwright/test';
import { workspaceIds as id, workspaceFixtures } from './workspaceFixtures';
const fixtures = workspaceFixtures();
const path = `/admin/guild/${id.guild}/operations/restrictions`;
test.beforeAll(() => fixtures.start());
test.afterAll(() => fixtures.stop());
test.beforeEach(async ({ context, baseURL }) => fixtures.reset(context, baseURL!));

test('signed-out deep link keeps the audit return path and insufficient authority hides findings', async ({
  context,
  page,
}) => {
  const audit = await fixtures.seedRestrictionAudit();
  const deep = `${path}?audit=${audit.auditRequestId}`;
  fixtures.setSelectedAuthority(false, '32');
  await page.goto(deep);
  await expect(
    page.getByRole('heading', { name: 'Server access required', exact: true })
  ).toBeVisible();
  await expect(page.getByText('Keep #rules read-only', { exact: true })).toHaveCount(0);
  await context.clearCookies();
  const response = await page.request.get(deep, { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  const location = response.headers().location;
  expect(new URL(location, 'http://127.0.0.1').searchParams.get('returnTo')).toBe(deep);
});

test('keyboard and bulk selection require new approval, queue durable work and recover interrupted results', async ({
  page,
}, info) => {
  const audit = await fixtures.seedRestrictionAudit();
  await page.goto(`${path}?audit=${audit.auditRequestId}`);
  await expect(page.getByRole('heading', { name: 'Restriction setup', exact: true })).toBeVisible();
  await expect(page.locator('details[open]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.getByText('3 changes selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeDisabled();
  const choice = page.getByRole('checkbox', { name: /Keep #rules read-only/ });
  await choice.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review your changes', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Review selected changes' })).not.toContainText(
    'Protect #workshop'
  );
  await page
    .getByRole('checkbox', { name: 'I approve these changes and their access effects.' })
    .check();
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await page.getByRole('checkbox', { name: /Protect #workshop/ }).check();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'I approve these changes and their access effects.' })
  ).not.toBeChecked();
  await page.screenshot({ path: info.outputPath('review-desktop.png'), fullPage: true });
  await page
    .getByRole('checkbox', { name: 'I approve these changes and their access effects.' })
    .check();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page).toHaveURL(/apply=/);
  await expect(page.getByRole('status')).toContainText('Applying selected changes');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Applying selected changes');
  const row = await fixtures.pool.query(
    `select metadata from moderation_action_requests where server_id=$1 and action_type='apply_case_role_lockdown'`,
    [id.guild]
  );
  expect(row.rows).toHaveLength(1);
  expect(row.rows[0].metadata.restriction_plan.selectedFixIds).toEqual(['exception', 'hardening']);
  await fixtures.finishRestrictionApply();
  await expect(page.getByRole('region', { name: 'Results' })).toContainText(
    'Batch stopped: interrupted',
    { timeout: 20_000 }
  );
  await expect(page.getByRole('region', { name: 'Results' })).toContainText(
    'Server setup: incomplete'
  );
  await expect(page.getByRole('region', { name: 'Results' })).toContainText('Current case');
  await expect(page.getByRole('region', { name: 'Results' })).toContainText('unknown');
  await page.screenshot({ path: info.outputPath('interrupted-results.png'), fullPage: true });
});

test('material settings edits reject old approval without queueing writes', async ({ page }) => {
  const audit = await fixtures.seedRestrictionAudit();
  await page.goto(`${path}?audit=${audit.auditRequestId}`);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'I approve these changes and their access effects.' })
    .check();
  await fixtures.pool.query(
    `update servers set settings=settings || '{"role_quarantine_mode":"on"}'::jsonb where guild_id=$1`,
    [id.guild]
  );
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.locator('main [role=alert]')).toContainText('Permissions or settings changed');
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
  expect(
    (
      await fixtures.pool.query(
        `select count(*)::int n from moderation_action_requests where server_id=$1 and action_type='apply_case_role_lockdown'`,
        [id.guild]
      )
    ).rows[0].n
  ).toBe(0);
});

for (const width of [390, 1280])
  for (const theme of ['dark', 'light'] as const) {
    test(`chooser ${width}px ${theme} keeps footer clear`, async ({ page }, info) => {
      const audit = await fixtures.seedRestrictionAudit();
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('drasil-theme', value), theme);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`${path}?audit=${audit.auditRequestId}`);
      await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`chooser-${width}-${theme}.png`),
        fullPage: true,
      });
      await page
        .getByRole('link', { name: 'Edit read-only exception channels', exact: true })
        .scrollIntoViewIfNeeded();
      const footer = await page.locator('footer').boundingBox();
      const link = await page
        .getByRole('link', { name: 'Edit read-only exception channels', exact: true })
        .boundingBox();
      expect(link!.y + link!.height).toBeLessThanOrEqual(footer!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );
      await page.screenshot({
        path: info.outputPath(`footer-${width}-${theme}.png`),
        fullPage: true,
      });
    });
  }
test('all automatic fixes can be reviewed together and navigation retains choices without approval', async ({
  page,
}) => {
  const audit = await fixtures.seedRestrictionAudit();
  await page.goto(path);
  await expect(page.getByText('Allowed access: Own case thread')).toContainText(
    '#rules (read-only)'
  );
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.reload();
  await expect(page.getByText('3 changes selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review selected changes' });
  await expect(review).toContainText(/Deny Send Messages In Threads.*for Restricted in #rules/);
  await expect(review).toContainText('Remove and save Community');
  await expect(review).toContainText('Deny View Channel for Restricted in #workshop');
  await expect(review).not.toContainText('Protected staff access needs attention');
  await page
    .getByRole('checkbox', { name: 'I approve these changes and their access effects.' })
    .check();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toHaveCount(0);
  expect(audit.auditRequestId).toBeTruthy();
});

test('idle approval expires without another interaction', async ({ page }) => {
  const audit = await fixtures.seedRestrictionAudit();
  await page.clock.install();
  await page.goto(`${path}?audit=${audit.auditRequestId}`);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const approval = page.getByRole('checkbox', {
    name: 'I approve these changes and their access effects.',
  });
  await approval.check();
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
  await page.clock.fastForward(10 * 60 * 1000 + 1000);
  await expect(
    page.getByRole('region', { name: 'Review selected changes' }).getByRole('alert')
  ).toContainText('This review expired');
  await expect(approval).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
});
