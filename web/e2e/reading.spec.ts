import { expect, test } from "@playwright/test";
import { CELTIC_CARDS, CELTIC_POSITION_NAMES, cardAlt, mockApi } from "./mocks/api";

test("reading: cast a chart, run a chart-informed Celtic Cross, find it in the journal", async ({ page }) => {
  const api = await mockApi(page, { balance: 3 });

  // --- birth chart form ---
  await page.goto("/chart/new/");
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Birth date").fill("1990-05-15");
  await page.getByLabel("Birth time", { exact: true }).fill("09:15");

  const place = page.getByRole("combobox", { name: "Birth place" });
  await place.fill("Hull");
  await page.getByRole("option", { name: "Hull, MA, USA" }).click();
  await expect(place).toHaveValue("Hull, MA, USA");
  await expect(page.getByText("Time zone: America/New_York")).toBeVisible();

  await page.getByRole("button", { name: "Cast my chart" }).click();
  await expect(page).toHaveURL(/\/chart\/\?id=p1$/);
  expect(api.calls.post["/profiles"]).toBe(1);
  await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();

  // --- new reading through that chart ---
  await page.goto("/reading/new/?profile=p1");
  await page.getByRole("radio", { name: /Celtic Cross/ }).check();
  await expect(page.getByText("Costs 3 credits · you have 3")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Read through my chart" })).toBeChecked();
  await page.getByRole("button", { name: "Begin the reading" }).click();

  await expect(page.getByRole("heading", { name: "Celtic Cross" })).toBeVisible();
  const slots = page.getByRole("group");
  await expect(slots).toHaveCount(10);
  for (const name of CELTIC_POSITION_NAMES) {
    await expect(page.getByRole("group", { name })).toBeAttached();
  }
  // cards reveal one at a time (600 ms apart): wait for every face to be announced
  for (const card of CELTIC_CARDS) {
    await expect(page.getByRole("img", { name: cardAlt(card) })).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText(/The cross speaks of a threshold/)).toBeVisible();
  await expect(page.getByText(/For reflection and entertainment\./)).toBeVisible();
  await expect(page.getByText("Saved to your journal.")).toBeVisible();
  expect(api.calls.post["/readings"]).toBe(1);
  expect(api.state.readings[0].chart_id).toBe("p1");
  // the spread was debited server-side and the UI re-read the balance
  await expect(page.getByLabel("Credit balance")).toHaveText(/0$/);

  // --- journal ---
  await page.getByRole("link", { name: "Open journal" }).click();
  await expect(page).toHaveURL(/\/journal\/$/);
  const row = page.getByRole("link", { name: /Celtic Cross/ });
  await expect(row).toBeVisible();
  await expect(row.getByText(/The cross speaks of a threshold/)).toBeVisible();
  await expect(row.getByRole("img", { name: cardAlt(CELTIC_CARDS[0]) })).toBeVisible();
});
