import { expect, test } from '@playwright/test';
const story = '/iframe.html?id=moderation-workspace-response-controls--mixed&viewMode=story';
async function confirm(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(`Confirm ${label}`).check();
  await dialog.getByRole('button', { name: `Confirm ${label}`, exact: true }).click();
}
test('mixed actions retain separate queue and detection bindings and track the close receipt', async ({
  page,
}) => {
  await page.goto(story);
  await confirm(page, 'Acknowledge response');
  await expect(page.getByTestId('submitted-target')).toHaveText('ack:response-queue');
  await expect(page.getByRole('button', { name: 'Close alert', exact: true })).toBeEnabled();
  await confirm(page, 'Close alert');
  await expect(page.getByTestId('submitted-target')).toHaveText('dismiss_no_action:det-observed-1');
  await expect(page.getByTestId('tracked-request')).toHaveText('response-close-request');
  await page.getByRole('button', { name: 'Finish queued close' }).click();
  await expect(page.getByText('Review alert closed.', { exact: true })).toBeVisible();
});
test('queue replacement disables stale acknowledgement while detection close remains bound', async ({
  page,
}) => {
  await page.goto(story);
  await page.getByRole('button', { name: 'Replace queue association' }).click();
  await expect(
    page.getByRole('button', { name: 'Acknowledge response', exact: true })
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close alert', exact: true })).toBeEnabled();
  await confirm(page, 'Close alert');
  await expect(page.getByTestId('submitted-target')).toHaveText('dismiss_no_action:det-observed-1');
});
