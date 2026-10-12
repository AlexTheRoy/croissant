/*
 * Pure helpers shared by the bookmarklet and the tests.
 * No DOM access in here, so everything can be unit tested in Node.
 */

var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar/clock parts for `date` as seen in time zone `tz`. */
function tzParts(tz, date) {
  var fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  var out = {};
  fmt.formatToParts(date).forEach(function (p) {
    out[p.type] = p.value;
  });
  // Some engines report midnight as "24".
  out.hour = String(+out.hour % 24);
  return out;
}

/** Offset of `tz` from UTC at instant `date`, in ms (e.g. -7h for PDT). */
function tzOffsetMs(tz, date) {
  var p = tzParts(tz, date);
  var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  var whole = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - whole;
}

/** UTC instant (ms) of local midnight for calendar date y-m-d in `tz`. DST safe. */
function localMidnightUtc(tz, y, m, d) {
  var naive = Date.UTC(y, m - 1, d);
  // First guess with the offset at the naive instant, then correct once using
  // the offset at the guess (handles days where DST changes).
  var guess = naive - tzOffsetMs(tz, new Date(naive));
  return naive - tzOffsetMs(tz, new Date(guess));
}

/** [startISO, endISO] covering "today" in `tz`, inclusive of the last ms. */
function dayWindow(tz, now) {
  var p = tzParts(tz, now || new Date());
  var y = +p.year,
    m = +p.month,
    d = +p.day;
  var start = localMidnightUtc(tz, y, m, d);
  var next = new Date(Date.UTC(y, m - 1, d + 1));
  var end = localMidnightUtc(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1;
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}

/** "YYYY-MM-DD" for today in `tz`. */
function todayKey(tz, now) {
  var p = tzParts(tz, now || new Date());
  return p.year + "-" + p.month + "-" + p.day;
}

/** 0 (Sun) to 6 (Sat) for today in `tz`. */
function weekdayIndex(tz, now) {
  return WEEKDAYS.indexOf(tzParts(tz, now || new Date()).weekday);
}

/**
 * Thresholds newly crossed since the last alert.
 * @param {number|null} pct      spend as % of budget
 * @param {number[]} thresholds  sorted ascending
 * @param {number} lastFired     highest threshold already alerted today (0 if none)
 */
function crossedThresholds(pct, thresholds, lastFired) {
  if (pct == null || !isFinite(pct)) return [];
  return thresholds.filter(function (t) {
    return pct >= t && t > (lastFired || 0);
  });
}

/** Parse "25, 50 75" into a sorted, de-duplicated list of positive numbers. */
function parseThresholds(str) {
  var seen = {};
  return String(str || "")
    .split(/[\s,;%]+/)
    .map(Number)
    .filter(function (n) {
      if (!(n > 0) || seen[n]) return false;
      seen[n] = true;
      return true;
    })
    .sort(function (a, b) {
      return a - b;
    });
}

/** Parse a budget the user typed ("$1,250.50"). Returns null if empty/invalid. */
function parseMoney(str) {
  var clean = String(str == null ? "" : str).replace(/[^0-9.]/g, "");
  if (clean === "") return null;
  var n = parseFloat(clean);
  return isFinite(n) && n >= 0 ? n : null;
}

/** CSS class for a pace percentage. */
function paceClass(pct) {
  if (pct == null) return "n";
  if (pct >= 100) return "x";
  if (pct >= 75) return "w";
  if (pct >= 50) return "q";
  return "";
}

function money(n) {
  return "$" + (+n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* istanbul ignore next */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    tzParts: tzParts,
    tzOffsetMs: tzOffsetMs,
    localMidnightUtc: localMidnightUtc,
    dayWindow: dayWindow,
    todayKey: todayKey,
    weekdayIndex: weekdayIndex,
    crossedThresholds: crossedThresholds,
    parseThresholds: parseThresholds,
    parseMoney: parseMoney,
    paceClass: paceClass,
    money: money,
    esc: esc,
  };
}
