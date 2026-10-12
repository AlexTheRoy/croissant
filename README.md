# 🥐 Croissant: Budget Pace Alerts

A Chrome bookmarklet for the GOAL admin dashboard. It watches today's ad spend
for each of your accounts and sends a desktop notification when an account
crosses 25%, 50%, 75% or 100% of its daily budget.

It is **read only**. It never changes budgets, bids or anything else in GOAL.

## How it works

- Runs in the GOAL admin tab and uses your own signed-in session
  (`authAdminUser` in local storage) to call the admin analytics
  `quote_funnels` endpoint, grouped by account, for today (midnight to
  midnight Pacific, DST safe).
- Compares each account's spend with its daily budget for today's weekday.
  Budgets come from `accounts.json`, which is baked into the bookmarklet at
  build time. You can override any budget in the panel; overrides are saved
  in that browser's local storage. Clear the box to go back to the built-in
  number; anything that isn't a dollar amount is ignored.
- One alert per threshold per account per day. The first check after
  launching records a baseline without alerting, so you don't get a burst of
  alerts for crossings that already happened.
- Re-checks every 5 minutes by default (2 to 30 is selectable), and catches up
  right away when you come back to a tab Chrome had throttled.

## Project layout

| Path | What it is |
| --- | --- |
| `src/bookmarklet.js` | The panel, polling and alert logic |
| `src/lib.js` | Pure helpers (time zone math, thresholds, parsing) shared with tests |
| `src/installer.html` | The drag-to-bookmarks installer page template |
| `build.mjs` | Validates the data, bundles and minifies, writes `dist/` |
| `accounts.example.json` | Shape of the account data file |
| `test/` | Unit tests (`npm test`) |
| `scripts/e2e.cjs` | Headless Chromium check against a mocked GOAL API |

## Account data stays out of git

`accounts.json` holds client names, account IDs, brand IDs and budgets, so it
is gitignored, and so is `dist/` (the built bookmarklet embeds that data).
Keep the real file locally and never commit it to this repository.

```json
{
  "asOf": "2026-10-02",
  "timezone": "America/Los_Angeles",
  "accountManagerId": null,
  "accounts": {
    "1001": { "name": "Agency name", "brandId": 2001, "budgets": [150, 150, 150, 150, 150, 150, 150] }
  }
}
```

- `budgets` is 7 numbers, **Sunday first**. Use `0` for no budget.
- `brandId` lets the agency name link straight to its GOAL dashboard. Use
  `null` if unknown.
- `accountManagerId` filters the API to your book of accounts. Use `null`
  for no filter.
- The panel shows a reminder once `asOf` is 14 or more days old.

## Build

```bash
npm install
cp accounts.example.json accounts.json   # first time only, then fill it in
npm run build                            # -> dist/index.html, dist/bookmarklet.txt
```

Open `dist/index.html` in Chrome and drag the button to the bookmarks bar.
When you rebuild with new budgets, delete the old bookmark and drag the new
one in. Saved overrides and settings carry over.

## Test

```bash
npm test                     # unit tests
npm run build:example        # build with example data into dist-example/
npm run e2e                  # build the example, then run it in headless Chromium
```

The end-to-end check needs Playwright, which is not a project dependency:
`npm install --no-save playwright && npx playwright install chromium`.
CI runs all three on every push and pull request.
