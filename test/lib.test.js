const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/lib.js");

const LA = "America/Los_Angeles";

test("dayWindow covers a normal Pacific day (PDT, UTC-7)", () => {
  const [s, e] = L.dayWindow(LA, new Date("2026-10-12T20:00:00Z"));
  assert.equal(s, "2026-10-12T07:00:00.000Z");
  assert.equal(e, "2026-10-13T06:59:59.999Z");
});

test("dayWindow just after midnight Pacific belongs to the new day", () => {
  const [s] = L.dayWindow(LA, new Date("2026-10-13T07:05:00Z"));
  assert.equal(s, "2026-10-13T07:00:00.000Z");
});

test("dayWindow on fall-back day is 25 hours", () => {
  // 2026-11-01: PDT -> PST
  const [s, e] = L.dayWindow(LA, new Date("2026-11-01T20:00:00Z"));
  assert.equal(s, "2026-11-01T07:00:00.000Z");
  assert.equal(e, "2026-11-02T07:59:59.999Z");
});

test("dayWindow on spring-forward day is 23 hours", () => {
  // 2026-03-08: PST -> PDT
  const [s, e] = L.dayWindow(LA, new Date("2026-03-08T20:00:00Z"));
  assert.equal(s, "2026-03-08T08:00:00.000Z");
  assert.equal(e, "2026-03-09T06:59:59.999Z");
});

test("dayWindow the evening before a DST change uses the old offset", () => {
  const [s, e] = L.dayWindow(LA, new Date("2026-03-08T05:00:00Z")); // Mar 7, 9pm PST
  assert.equal(s, "2026-03-07T08:00:00.000Z");
  assert.equal(e, "2026-03-08T07:59:59.999Z");
});

test("todayKey and weekdayIndex use the configured zone, not the machine's", () => {
  const late = new Date("2026-10-13T03:00:00Z"); // Mon Oct 12, 8pm Pacific; already Tue in UTC
  assert.equal(L.todayKey(LA, late), "2026-10-12");
  assert.equal(L.weekdayIndex(LA, late), 1);
  assert.equal(L.weekdayIndex("UTC", late), 2);
});

test("crossedThresholds only returns new crossings", () => {
  const th = [25, 50, 75, 100];
  assert.deepEqual(L.crossedThresholds(10, th, 0), []);
  assert.deepEqual(L.crossedThresholds(55, th, 0), [25, 50]);
  assert.deepEqual(L.crossedThresholds(55, th, 50), []);
  assert.deepEqual(L.crossedThresholds(101, th, 50), [75, 100]);
  assert.deepEqual(L.crossedThresholds(null, th, 0), []);
  assert.deepEqual(L.crossedThresholds(Infinity, th, 0), []);
});

test("parseThresholds sorts, de-duplicates and drops junk", () => {
  assert.deepEqual(L.parseThresholds("75, 25 50,50%, x, -5, 0"), [25, 50, 75]);
  assert.deepEqual(L.parseThresholds(""), []);
});

test("parseMoney handles $ and commas, empty means clear", () => {
  assert.equal(L.parseMoney("$1,250.50"), 1250.5);
  assert.equal(L.parseMoney("0"), 0);
  assert.equal(L.parseMoney("  "), null);
  assert.equal(L.parseMoney("abc"), null);
});

test("paceClass buckets", () => {
  assert.equal(L.paceClass(null), "n");
  assert.equal(L.paceClass(10), "");
  assert.equal(L.paceClass(50), "q");
  assert.equal(L.paceClass(75), "w");
  assert.equal(L.paceClass(100), "x");
});

test("esc and money", () => {
  assert.equal(L.esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  assert.equal(L.money(1234.5), "$1,234.50");
  assert.equal(L.money(undefined), "$0.00");
});
