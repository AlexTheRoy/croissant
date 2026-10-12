/*
 * End-to-end check of the built bookmarklet in headless Chromium against a
 * mocked GOAL API. Run after `npm run build:example`:
 *   node scripts/e2e.cjs [dist-example/bookmarklet.txt] [screenshot.png]
 * Requires playwright (not a project dependency).
 */
const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("assert/strict");

const bmPath = process.argv[2] || "dist-example/bookmarklet.txt";
const shot = process.argv[3];
const code = decodeURIComponent(fs.readFileSync(bmPath, "utf8").trim().replace(/^javascript:/, ""));
const ORIGIN = "https://admin.goal.test";

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let spend = {};
  let delay = 0;
  let calls = 0;
  let lastBody = null;
  await page.route(ORIGIN + "/**", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>GOAL Admin</title><body></body>" }));
  await page.route("https://api.portal.checkoutgoal.com/**", async (r) => {
    calls++;
    lastBody = JSON.parse(r.request().postData());
    if (delay) await new Promise((res) => setTimeout(res, delay));
    const data = Object.entries(spend).map(([id, s]) => ({ account_id: +id, company_name: "API " + id, click_analytic_total_cost: String(s) }));
    r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ data }) }).catch(() => {});
  });
  await page.addInitScript(() => {
    localStorage.setItem("authAdminUser", JSON.stringify({ token: "tok" }));
    window.__notes = [];
    const N = function (title, opts) { window.__notes.push({ title, body: opts && opts.body }); this.close = () => {}; };
    N.permission = "granted";
    N.requestPermission = () => Promise.resolve("granted");
    window.Notification = N;
  });
  await page.goto(ORIGIN + "/dashboard");

  const run = () => page.evaluate(code);
  const settle = () => page.waitForFunction(() => !document.querySelector("#bpw-now") || !document.querySelector("#bpw-now").disabled);

  // 1. Baseline: account 1001 already at 60% -> no alert, logged.
  spend = { 1001: 90, 9999: 12 };
  await run();
  await page.waitForSelector("#bpw-rows tr");
  await settle();
  assert.equal(await page.locator("#bpw-rows tr").count(), 3, "two budgeted accounts + one unknown spender");
  assert.equal((await page.evaluate(() => window.__notes)).length, 0, "baseline sends no alerts");
  assert.match(await page.textContent("#bpw-log"), /Baseline: 1 account/);
  assert.ok(lastBody.start_date.endsWith(":00:00.000Z") && lastBody.end_date.endsWith(":59:59.999Z"));
  assert.equal(lastBody.account_manager_ids, null, "null accountManagerId means no filter");
  assert.match(await page.textContent("#bpw-rows"), /API 9999/);

  // 2. Crossing 75% and 100% fires one notification for the top threshold.
  spend = { 1001: 151, 9999: 12 };
  await page.evaluate(() => window.__bpw.poll());
  await settle();
  let notes = await page.evaluate(() => window.__notes);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /hit 100% of daily budget/);
  assert.match(notes[0].body, /crossed 75%, 100%/);
  assert.match(await page.title(), /^\(1 at 100%\) /);

  // 3. Same state again -> no duplicate alert.
  await page.evaluate(() => window.__bpw.poll());
  await settle();
  assert.equal((await page.evaluate(() => window.__notes)).length, 1, "no repeat alert");

  // 4. Typing in a budget box is not wiped by a background refresh.
  const input = page.locator('input.bud[data-id="1001"]');
  await input.click();
  await input.fill("4");
  await page.evaluate(() => window.__bpw.poll());
  await settle();
  assert.equal(await input.inputValue(), "4", "in-progress edit survives a poll");
  await input.fill("$1,000");
  await input.press("Enter");
  await settle();
  await page.waitForFunction(() => /\$1,000\.00/.test(document.querySelector("#bpw-log").textContent));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("__bpw_v1")).over);
  assert.deepEqual(saved, { 1001: 1000 });
  assert.ok(await page.locator('input.bud.ov[data-id="1001"]').count(), "override is highlighted");

  // 5. Clicking the bookmark again reopens the same panel, no duplicates.
  await page.click("#bpw-min");
  await run();
  assert.equal(await page.locator("#bpw").count(), 1);
  assert.equal(await page.locator("#bpw.min").count(), 0, "reopen un-minimizes");

  // 6. Overlapping polls are collapsed.
  delay = 400;
  const before = calls;
  await page.evaluate(() => { window.__bpw.poll(); window.__bpw.poll(); window.__bpw.poll(); });
  await settle();
  assert.equal(calls - before, 1, "only one request in flight");

  if (shot) await page.screenshot({ path: shot, clip: { x: 1200 - 520, y: 800 - 600, width: 520, height: 600 } });

  // 7. Closing while a request is in flight does not resurrect the panel.
  await page.evaluate(() => window.__bpw.poll());
  await page.click("#bpw-x");
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#bpw").count(), 0, "panel stays closed");
  assert.equal(await page.locator("#bpw-style").count(), 0, "styles removed");
  assert.equal(await page.evaluate(() => typeof window.__bpw), "undefined");
  assert.equal(await page.title(), "GOAL Admin");

  // 8. No session -> friendly message, no request.
  await page.evaluate(() => localStorage.removeItem("authAdminUser"));
  const c0 = calls;
  await run();
  await page.waitForSelector("#bpw-err .err");
  assert.match(await page.textContent("#bpw-err"), /No GOAL admin session/);
  assert.equal(calls, c0);

  // 9. Session expiry is reported.
  await page.evaluate(() => { window.__bpw.stop(); localStorage.setItem("authAdminUser", JSON.stringify({ token: "tok" })); });
  await page.unroute("https://api.portal.checkoutgoal.com/**");
  await page.route("https://api.portal.checkoutgoal.com/**", (r) => r.fulfill({ status: 401, headers: { "access-control-allow-origin": "*" }, body: "" }));
  await run();
  await page.waitForSelector("#bpw-err .err");
  assert.match(await page.textContent("#bpw-err"), /session expired/);

  assert.deepEqual(errors, [], "no page errors");
  await browser.close();
  console.log("e2e: all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
