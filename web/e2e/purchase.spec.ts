import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks/api";

const BUY_STARTER = { name: "Buy Starter: 5 credits for $4.99" };

test("purchase: anonymous buyer signs in by magic link, buys, sees credits land after the webhook", async ({
  page,
}) => {
  const api = await mockApi(page, { balance: 0 });

  // --- anonymous: Buy opens the sign-in sheet ---
  await page.goto("/store/");
  await expect(page.getByText("Your balance:")).toBeVisible();
  await page.getByRole("button", BUY_STARTER).click();

  const sheet = page.getByRole("dialog", { name: "Sign in to buy credits" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Email a sign-in link").fill("ada@example.com");
  await sheet.getByRole("button", { name: "Email me a link" }).click();
  await expect(sheet.getByText("Check your email")).toBeVisible();
  await expect(sheet.getByText("ada@example.com")).toBeVisible();
  expect(api.calls.post["/auth/magic/request"]).toBe(1);
  expect(api.calls.post["/auth/anonymous"]).toBe(1);

  // --- the emailed link lands on /auth/magic/?token= ---
  const magic = api.state.magicTokens[0];
  expect(magic).toBeTruthy();
  await page.goto(`/auth/magic/?token=${magic}`);
  await expect(page).toHaveURL(/\/account\/$/);
  await expect(page.getByText("Signed in as")).toBeVisible();
  await expect(page.getByText("ada@example.com")).toBeVisible();
  expect(api.calls.post["/auth/magic/verify"]).toBe(1);

  // --- signed in: Buy charges (mock billing) and waits for the webhook ---
  await page.goto("/store/");
  await expect(page.getByText("Your balance:")).toBeVisible();
  await expect(page.getByText("Your balance:")).toContainText("0");
  await page.getByRole("button", BUY_STARTER).click();

  const status = page.getByRole("status", { name: "Purchase status" });
  await expect(status).toHaveText(/Processing your purchase/);
  expect(api.state.balance).toBe(0);

  // the API's webhook credits the account; the store polls /me every 2 s
  api.simulateWebhook(5);
  await expect(status).toHaveText("Your credits are in. Balance: 5.", { timeout: 10_000 });
  await expect(page.getByText("Your balance:")).toContainText("5");
  await expect(page.getByText("Credit balance:").locator("..")).toHaveText(/5$/);
  await expect(page.getByRole("button", BUY_STARTER)).toBeEnabled();
});
