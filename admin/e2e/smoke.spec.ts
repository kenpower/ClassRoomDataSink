import { expect, test, type Page } from '@playwright/test';
import { SignJWT } from 'jose';

const SECRET = process.env.E2E_STARS_SECRET ?? 'local-stars-secret-local-stars-secret';

/** "Mocked" STARS login: sign the token the auth service would issue and hit our callback directly. */
async function login(page: Page, email = 'teacher@setu.ie') {
  // Never reach the real auth service from tests.
  await page.route(/compucore|srlstars|statsskills/, (r) => r.abort());
  const token = await new SignJWT({ user_id: email, email, display_name: 'E2E Teacher', auth_provider: 'microsoft' })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(SECRET));
  await page.goto(`/api/v1/auth/callback?token=${token}&origin_url=/admin/`);
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
}

test('rejects accounts that are not staff', async ({ page }) => {
  await page.route(/compucore/, (r) => r.abort());
  const token = await new SignJWT({ email: 'random@gmail.com' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(SECRET));
  await page.goto(`/api/v1/auth/callback?token=${token}`);
  await expect(page.getByRole('alert')).toContainText('not authorised as staff');
  expect(page.url()).not.toContain('code=');
});

test('create a room and watch live counters update', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);

  await page.getByRole('link', { name: 'New room', exact: true }).first().click();
  await page.getByLabel('Title').fill('E2E lecture');
  await page.getByLabel('Open the room straight away').check();
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByText('It is shown only this once')).toBeVisible();
  const code = (await page.getByRole('heading', { name: /Room .* created/ }).textContent())!.match(/Room (\w{6})/)![1]!;
  await page.getByRole('link', { name: 'Go to dashboard' }).click();

  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByTestId('clients')).toHaveText('0');
  await page.getByLabel('Client app URL').fill('https://apps.example.ie/quiz/');
  await expect(page.getByRole('img', { name: `QR code to join room ${code}` })).toBeVisible();

  // A student joins and sends events, including an XSS attempt.
  const join = await (await request.post(`/api/v1/rooms/${code}/join`, { data: {} })).json();
  const send = (data: unknown, key: string) =>
    request.post(`/api/v1/rooms/${code}/events`, {
      headers: { authorization: `Bearer ${join.token}`, 'idempotency-key': key },
      data: { app: 'quiz', data },
    });
  expect((await send({ answer: 'B' }, 'k1')).status()).toBe(202);
  expect((await send({ s: '<img src=x onerror=alert(1)>' }, 'k2')).status()).toBe(202);

  await expect(page.getByTestId('clients')).toHaveText('1', { timeout: 5000 });
  await expect(page.getByTestId('events')).toHaveText('2', { timeout: 5000 });
  // Payload shown as text, never as HTML.
  await expect(page.getByRole('cell', { name: /<img src=x onerror=alert\(1\)>/ })).toBeVisible();
  expect(await page.locator('td img').count()).toBe(0);

  // Toggle an app off and back on.
  const sw = page.getByRole('switch', { name: 'quiz' });
  await sw.uncheck();
  await expect(sw).not.toBeChecked();
  await expect.poll(async () => (await send({ answer: 'C' }, 'k3')).status()).toBe(403);
  await sw.check();

  // Back to the list; delete needs typing the code.
  await page.getByRole('link', { name: 'Rooms', exact: true }).click();
  await expect(page.getByRole('link', { name: code, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Delete room ${code}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Delete room' })).toBeDisabled();
  await dialog.getByLabel(/Type/).fill(code);
  await dialog.getByRole('button', { name: 'Delete room' }).click();
  await expect(page.getByRole('link', { name: code, exact: true })).toHaveCount(0);

  expect(errors.filter((e) => !/compucore|ERR_FAILED/.test(e))).toEqual([]);
});
