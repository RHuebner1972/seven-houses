import { expect, test } from "@playwright/test";
import { mockApi } from "./mocks/api";

test("daily card: reveal streams a card, reload serves it from cache without a new POST", async ({ page }) => {
  const api = await mockApi(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your card for today" })).toBeVisible();

  await page.getByRole("button", { name: "Reveal card" }).click();

  // the `cards` event flips the card face-up; the deltas fill the text
  await expect(page.getByRole("img", { name: "The Fool, upright" })).toBeVisible();
  await expect(page.getByText("The Fool", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/Step lightly into what the day offers/)).toBeVisible();
  await expect(page.getByText("Your card renews at midnight")).toBeVisible();
  expect(api.calls.post["/daily"]).toBe(1);

  // Same local day: the Today page must show the cached card and not ask the API again.
  await page.reload();
  await expect(page.getByRole("img", { name: "The Fool, upright" })).toBeVisible();
  await expect(page.getByText(/Step lightly into what the day offers/)).toBeVisible();
  await expect(page.getByText("Your card renews at midnight")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal card" })).toHaveCount(0);
  expect(api.calls.post["/daily"]).toBe(1);
});
