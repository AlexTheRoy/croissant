/*
 * Croissant: Budget Pace Alerts bookmarklet.
 *
 * Runs on the GOAL admin dashboard, polls today's spend per account from the
 * admin analytics endpoint using the signed-in session, and raises a desktop
 * notification when an account crosses 25/50/75/100% of its daily budget.
 *
 * Read only: it never writes anything to GOAL.
 *
 * Build with `npm run build`. The build wraps this file and src/lib.js in an
 * IIFE and replaces __CROISSANT_CONFIG__ with the contents of accounts.json.
 */

/* global __CROISSANT_CONFIG__ */

if (window.__bpw && window.__bpw.open) {
  window.__bpw.open();
  return;
}

var CFG = __CROISSANT_CONFIG__;
var TZ = CFG.timezone || "America/Los_Angeles";
var ACCOUNTS = CFG.accounts || {};
var API = "https://api.portal.checkoutgoal.com/api/v2/admin_analytics/quote_funnels";
var PORTAL = "https://www.portal.checkoutgoal.com/dashboard";
var STORE = "__bpw_v1"; // kept from v1 so saved overrides carry over
var STALE_DAYS = 14;
var INTERVALS = [2, 5, 10, 15, 30];
var TIMEOUT_MS = 30000;

var DEFAULTS = { every: 5, th: [25, 50, 75, 100], sound: true, over: {} };

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Saved state can be missing, from an older build, or hand edited: never trust its shape.
function readStore(key) {
  try {
    var v = JSON.parse(localStorage.getItem(key) || "{}");
    return isObject(v) ? v : {};
  } catch (e) {
    return {};
  }
}

var S = Object.assign({}, DEFAULTS, readStore(STORE));
if (!isObject(S.over)) S.over = {};
S.th = parseThresholds(Array.isArray(S.th) ? S.th.join(",") : "");
if (!S.th.length) S.th = DEFAULTS.th.slice();
S.every = +S.every;
if (!(S.every >= 1 && S.every <= 1440)) S.every = DEFAULTS.every;

var fired = readStore(STORE + "_fired");

var panel, styleEl, rowsEl, errEl, logEl, sumEl;
var rows = [];
var lastData = null; // rows from the last successful API response
var lastCheck = null; // time of the last successful poll
var lastAttempt = 0; // time of the last poll attempt, successful or not
var lastError = null;
var timer = null;
var running = true; // false while paused
var stopped = false; // true after the panel is closed
var minimized = false;
var baselined = false; // first successful poll records state without alerting
var inFlight = false;
var pendingRender = false;
var logLines = [];
var audio = null;
var prevIcon = null;

var ICON = (function () {
  try {
    var cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    var g = cv.getContext("2d");
    g.font = '52px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("🥐", 32, 36);
    return cv.toDataURL("image/png");
  } catch (e) {
    return null;
  }
})();

var CSS =
  "#bpw{position:fixed;right:16px;bottom:16px;width:470px;max-width:calc(100vw - 32px);max-height:72vh;z-index:2147483000;background:#1c1d20;color:#ededee;font:13px/1.4 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;border:1px solid #3e4045;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;text-align:left}" +
  "#bpw *{box-sizing:border-box}" +
  "#bpw.min{max-height:none;width:auto}#bpw.min .bpw-body,#bpw.min .bpw-foot,#bpw.min .sum,#bpw.min .logs{display:none}" +
  "#bpw .bpw-head{display:flex;align-items:center;gap:10px;padding:10px 12px;background:linear-gradient(180deg,#1b1c1f,#121314);border-bottom:1px solid #313337}" +
  "#bpw .bpw-head b{font-size:13px;letter-spacing:.02em;white-space:nowrap}#bpw .bpw-head small{white-space:nowrap}#bpw .bpw-head small{color:#a6a9ae;font-size:11px}" +
  "#bpw .bpw-sp{flex:1}" +
  "#bpw button{font:inherit;color:#ededee;background:#242528;border:1px solid #3e4045;border-radius:7px;padding:4px 9px;cursor:pointer;font-size:12px}" +
  "#bpw button:hover{border-color:#4fd1c5;color:#4fd1c5}#bpw button:disabled{opacity:.5;cursor:default}" +
  "#bpw .bpw-body{overflow:auto;padding:6px 0}" +
  "#bpw table{width:100%;border-collapse:collapse;table-layout:fixed}" +
  "#bpw col.c2{width:78px}#bpw col.c3{width:84px}#bpw col.c4{width:74px}" +
  "#bpw th{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#a6a9ae;text-align:left;padding:6px 10px;border-bottom:1px solid #313337;font-weight:600}" +
  "#bpw td{padding:6px 10px;border-bottom:1px solid #26272b;vertical-align:middle}" +
  "#bpw td.r,#bpw th.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
  "#bpw .nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#bpw .nm small{color:#7c7f86;margin-left:4px}" +
  "#bpw a.lnk{color:#ededee;text-decoration:none}#bpw a.lnk:hover,#bpw a.lnk:hover small{color:#4fd1c5;text-decoration:underline}" +
  "#bpw .bar{height:6px;background:#2d2f33;border-radius:3px;margin-top:4px;position:relative;overflow:hidden}" +
  "#bpw .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:#2fbf71}" +
  "#bpw .bar.q i{background:#5aa6e6}#bpw .bar.w i{background:#e0a93b}#bpw .bar.x i{background:#e2603f}" +
  "#bpw .pct{font-weight:600}#bpw .pct.q{color:#5aa6e6}#bpw .pct.w{color:#e0a93b}#bpw .pct.x{color:#e2603f}#bpw .pct.n{color:#7c7f86;font-weight:400}" +
  "#bpw input.bud{width:66px;font:inherit;background:#121314;color:#ededee;border:1px solid #3e4045;border-radius:5px;padding:2px 5px;text-align:right}" +
  "#bpw input.bud.ov{border-color:#5aa6e6}#bpw input.bud:focus{outline:none;border-color:#4fd1c5}" +
  "#bpw .bpw-foot{padding:8px 12px;border-top:1px solid #313337;color:#a6a9ae;font-size:11.5px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}" +
  "#bpw .bpw-foot label{display:inline-flex;gap:4px;align-items:center}" +
  "#bpw select,#bpw input.th{font:inherit;background:#121314;color:#ededee;border:1px solid #3e4045;border-radius:5px;padding:2px 4px;font-size:11.5px}" +
  "#bpw .err{background:rgba(226,96,63,.16);color:#e2603f;padding:6px 12px;font-size:12px}" +
  "#bpw .warn{background:rgba(224,169,59,.14);color:#e0a93b;padding:6px 12px;font-size:12px}" +
  "#bpw .logs{padding:6px 12px;color:#a6a9ae;font-size:11.5px;border-top:1px solid #313337;max-height:110px;overflow:auto;white-space:pre-wrap}#bpw .logs:empty{display:none}" +
  "#bpw .sum{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 12px;border-bottom:1px solid #313337;font-size:12px;color:#a6a9ae}" +
  "#bpw .sum b{color:#ededee;font-size:14px;display:block}";

/* ---------- state helpers ---------- */

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(S));
  } catch (e) {}
}

function budgetFor(id) {
  if (S.over[id] != null && S.over[id] !== "") return +S.over[id];
  var a = ACCOUNTS[id];
  return a && a.budgets ? +a.budgets[weekdayIndex(TZ)] || 0 : 0;
}

function nameFor(id, apiName) {
  return (ACCOUNTS[id] && ACCOUNTS[id].name) || apiName || "Account " + id;
}

function portalLink(id, apiRow) {
  var brand = (ACCOUNTS[id] && ACCOUNTS[id].brandId) || (apiRow && apiRow.brand_id);
  return brand ? PORTAL + "?admin_user=true&account_id=" + encodeURIComponent(id) + "&brand_id=" + encodeURIComponent(brand) : null;
}

function lastFiredFor(id) {
  var day = fired[todayKey(TZ)];
  return (day && day[id]) || 0;
}

function recordFired(id, threshold) {
  var key = todayKey(TZ);
  if (!isObject(fired[key])) fired[key] = {};
  fired[key][id] = threshold;
}

function saveFired() {
  var key = todayKey(TZ);
  Object.keys(fired).forEach(function (k) {
    if (k !== key) delete fired[k];
  });
  try {
    localStorage.setItem(STORE + "_fired", JSON.stringify(fired));
  } catch (e) {}
}

function log(msg) {
  var t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  logLines.unshift(t + "  " + msg);
  logLines = logLines.slice(0, 50);
}

function readToken() {
  try {
    return JSON.parse(localStorage.getItem("authAdminUser") || "{}").token || null;
  } catch (e) {
    return null;
  }
}

function daysSince(isoDate) {
  var then = Date.parse(isoDate + "T00:00:00Z");
  var now = Date.parse(todayKey(TZ) + "T00:00:00Z");
  return isFinite(then) ? Math.round((now - then) / 864e5) : 0;
}

/* ---------- polling ---------- */

function computeRows() {
  var data = lastData || [];
  var byId = {};
  var ids = {};
  Object.keys(ACCOUNTS).forEach(function (id) {
    ids[id] = 1;
  });
  data.forEach(function (r) {
    if (!r || r.account_id == null) return;
    byId[r.account_id] = r;
    // With onlyListedAccounts, accounts missing from accounts.json (e.g. not Active) never show.
    if (!CFG.onlyListedAccounts || ACCOUNTS[r.account_id]) ids[r.account_id] = 1;
  });
  return Object.keys(ids)
    .map(function (id) {
      var r = byId[id];
      var spend = (r && +r.click_analytic_total_cost) || 0;
      var bud = budgetFor(id);
      return {
        id: id,
        name: nameFor(id, r && r.company_name),
        link: portalLink(id, r),
        spend: spend,
        bud: bud,
        pct: bud > 0 ? (spend / bud) * 100 : null,
        over: S.over[id] != null,
      };
    })
    .filter(function (r) {
      // Keep overridden rows visible so a 0 override can always be cleared.
      return r.bud > 0 || r.spend > 0 || r.over;
    })
    .sort(function (a, b) {
      var pa = a.pct == null ? -1 : a.pct,
        pb = b.pct == null ? -1 : b.pct;
      return pb - pa || b.spend - a.spend;
    });
}

function poll() {
  if (stopped || inFlight) return;
  lastAttempt = Date.now();
  var token = readToken();
  if (!token) {
    lastError = "No GOAL admin session found on this page. Open the GOAL admin dashboard, sign in, then click the bookmark there.";
    render();
    return;
  }
  var win = dayWindow(TZ);
  var body = {
    start_date: win[0],
    end_date: win[1],
    timezone: TZ,
    states: null,
    lead_type_ids: null,
    campaign_ids: null,
    ad_group_ids: null,
    account_ids: null,
    brand_ids: null,
    marketing_groups: null,
    ad_ids: null,
    source_type_ids: null,
    device_types: null,
    account_manager_ids: CFG.accountManagerId != null ? [CFG.accountManagerId] : null,
    sales_manager_ids: null,
    insurance_carrier_ids: null,
    group_by_params: ["account_id"],
    invoice: null,
  };
  // Without a timeout a request that never settles would block every later check.
  var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timedOut = false;
  var timeout = setTimeout(function () {
    timedOut = true;
    if (ctl) ctl.abort();
  }, TIMEOUT_MS);
  inFlight = true;
  setBusy(true);
  fetch(API, {
    method: "POST",
    headers: { Authorization: token, "admin-token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: ctl ? ctl.signal : undefined,
  })
    .then(function (res) {
      if (res.status === 401 || res.status === 403) throw new Error("GOAL session expired. Sign in again, then click the bookmark.");
      if (!res.ok) throw new Error("GOAL API returned " + res.status + ". Will retry on the next check.");
      return res.json();
    })
    .then(function (json) {
      if (stopped) return;
      var data = json && json.data;
      if (!Array.isArray(data)) throw new Error("GOAL API sent an unexpected response. Will retry on the next check.");
      lastData = data;
      rows = computeRows();
      lastCheck = new Date();
      lastError = null;
      checkAlerts();
    })
    .catch(function (e) {
      lastError = (e && e.message) || String(e);
      if (timedOut) lastError = "GOAL took too long to respond. Will retry on the next check.";
      else if (/Failed to fetch|NetworkError/i.test(lastError)) lastError = "Couldn't reach GOAL (network). Will retry on the next check.";
    })
    .then(function () {
      clearTimeout(timeout);
      inFlight = false;
      setBusy(false);
      render();
    });
}

function checkAlerts() {
  var hits = [];
  rows.forEach(function (r) {
    var crossed = crossedThresholds(r.pct, S.th, lastFiredFor(r.id));
    if (!crossed.length) return;
    var top = Math.max.apply(null, crossed);
    recordFired(r.id, top);
    hits.push({ row: r, top: top, crossed: crossed });
  });
  if (hits.length) saveFired();

  if (!baselined) {
    baselined = true;
    if (hits.length)
      log(
        "Baseline: " + hits.length + " account" + (hits.length > 1 ? "s" : "") +
          " already past a threshold today (no alerts sent). New crossings alert from here on."
      );
    return;
  }
  if (!hits.length) return;

  hits.forEach(function (h) {
    var title = h.row.name + " (#" + h.row.id + ") hit " + h.top + "% of daily budget";
    var body =
      money(h.row.spend) + " of " + money(h.row.bud) + " spent today (" + Math.round(h.row.pct) + "%)" +
      (h.crossed.length > 1 ? ", crossed " + h.crossed.join("%, ") + "%" : "");
    notify(title, body, h.row.id);
    log(title + ". " + body);
  });
  if (S.sound) chime();
}

/* ---------- alerts ---------- */

function notify(title, body, id) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    var opts = { body: body, tag: "bpw-" + id + "-" + title, requireInteraction: false };
    if (ICON) opts.icon = opts.badge = ICON;
    var n = new Notification(title, opts);
    n.onclick = function () {
      window.focus();
      if (!stopped) open();
      n.close();
    };
  } catch (e) {}
}

// The AudioContext is created during the bookmark click (a user gesture) so
// Chrome's autoplay policy lets later chimes play from a background tab.
function initAudio() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !audio) audio = new AC();
  } catch (e) {}
}

function chime() {
  if (!audio) return;
  try {
    if (audio.state === "suspended") audio.resume();
    var osc = audio.createOscillator(),
      gain = audio.createGain(),
      t0 = audio.currentTime;
    osc.connect(gain);
    gain.connect(audio.destination);
    gain.gain.value = 0.08;
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.setValueAtTime(1175, t0 + 0.12);
    osc.start(t0);
    osc.stop(t0 + 0.26);
  } catch (e) {}
}

/* ---------- UI ---------- */

function build() {
  if (panel) return;
  styleEl = document.createElement("style");
  styleEl.id = "bpw-style";
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  panel = document.createElement("div");
  panel.id = "bpw";
  var opts = INTERVALS.concat(INTERVALS.indexOf(S.every) < 0 ? [S.every] : [])
    .sort(function (a, b) {
      return a - b;
    })
    .map(function (m) {
      return "<option value='" + m + "'>" + m + "</option>";
    })
    .join("");
  panel.innerHTML =
    '<div class="bpw-head"><b>🥐 Budget pace alerts</b><small id="bpw-stamp"></small><span class="bpw-sp"></span>' +
    '<button id="bpw-now" title="Check now">Refresh</button><button id="bpw-pause">Pause</button>' +
    '<button id="bpw-min" title="Minimize">&#8211;</button><button id="bpw-x" title="Stop and close">&#215;</button></div>' +
    '<div id="bpw-err"></div><div class="sum" id="bpw-sum"></div>' +
    '<div class="bpw-body"><table><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup>' +
    '<thead><tr><th>Account</th><th class="r">Spent</th><th class="r">Budget</th><th class="r">Pace</th></tr></thead>' +
    '<tbody id="bpw-rows"></tbody></table></div>' +
    '<div class="logs" id="bpw-log"></div>' +
    '<div class="bpw-foot"><label>Check every <select id="bpw-every">' + opts + "</select> min</label>" +
    '<label>Alerts at <input class="th" id="bpw-th" size="14"> %</label>' +
    '<label><input type="checkbox" id="bpw-snd"> chime</label><span class="bpw-sp"></span><span id="bpw-perm"></span></div>';
  document.body.appendChild(panel);

  rowsEl = panel.querySelector("#bpw-rows");
  errEl = panel.querySelector("#bpw-err");
  logEl = panel.querySelector("#bpw-log");
  sumEl = panel.querySelector("#bpw-sum");

  panel.querySelector("#bpw-now").onclick = poll;
  panel.querySelector("#bpw-pause").onclick = function () {
    running = !running;
    this.textContent = running ? "Pause" : "Resume";
    if (running) poll();
    render();
  };
  panel.querySelector("#bpw-min").onclick = function () {
    minimized = !minimized;
    panel.classList.toggle("min", minimized);
  };
  panel.querySelector("#bpw-x").onclick = stop;

  var every = panel.querySelector("#bpw-every");
  every.value = String(S.every);
  every.onchange = function () {
    S.every = +this.value;
    save();
    schedule();
  };

  var th = panel.querySelector("#bpw-th");
  th.value = S.th.join(", ");
  th.onchange = function () {
    var list = parseThresholds(this.value);
    if (list.length) {
      S.th = list;
      save();
    }
    this.value = S.th.join(", ");
  };

  var snd = panel.querySelector("#bpw-snd");
  snd.checked = !!S.sound;
  snd.onchange = function () {
    S.sound = this.checked;
    save();
    if (S.sound) {
      initAudio();
      chime();
    }
  };

  rowsEl.addEventListener("change", function (e) {
    var el = e.target;
    if (!el.classList.contains("bud")) return;
    var id = el.getAttribute("data-id");
    var v = parseMoney(el.value);
    if (v == null && el.value.trim() !== "") {
      // A typo must not wipe a saved override; only an empty box clears it.
      log('"' + el.value.trim() + '" is not a dollar amount, so the budget for #' + id + " was left as it was.");
      var cur = budgetFor(id);
      el.value = cur > 0 ? cur : "";
      render();
      return;
    }
    if (v == null) delete S.over[id];
    else S.over[id] = v;
    save();
    log(v == null ? "Budget override cleared for #" + id + "." : "Budget for #" + id + " set to " + money(v) + " (saved on this computer).");
    // Show the edit right away, even if the next check fails; poll() then handles alerts.
    if (lastData) rows = computeRows();
    render();
    poll();
  });
  // Don't redraw the table under someone who is typing a budget.
  rowsEl.addEventListener("focusout", function () {
    setTimeout(function () {
      if (pendingRender && !isEditing()) render();
    }, 0);
  });
  rowsEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.classList.contains("bud")) e.target.blur();
  });

  updatePermission();
}

function isEditing() {
  return !!(rowsEl && document.activeElement && rowsEl.contains(document.activeElement));
}

function setBusy(b) {
  if (!panel) return;
  var btn = panel.querySelector("#bpw-now");
  btn.disabled = b;
  btn.textContent = b ? "Checking..." : "Refresh";
}

function updatePermission() {
  if (!panel) return;
  var el = panel.querySelector("#bpw-perm");
  if (!("Notification" in window)) {
    el.textContent = "Notifications unsupported";
  } else if (Notification.permission === "granted") {
    el.textContent = "Notifications on";
  } else if (Notification.permission === "denied") {
    el.innerHTML = '<span style="color:#e2603f">Notifications blocked for this site (allow them in Chrome site settings)</span>';
  } else {
    var b = document.createElement("button");
    b.textContent = "Enable notifications";
    b.onclick = function () {
      Notification.requestPermission().then(updatePermission);
    };
    el.innerHTML = "";
    el.appendChild(b);
  }
}

function render() {
  if (stopped) return;
  build();

  panel.querySelector("#bpw-stamp").textContent =
    (lastCheck ? "checked " + lastCheck.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "starting") +
    (running ? "" : " (paused)");

  var notes = "";
  if (lastError) notes += '<div class="err">' + esc(lastError) + "</div>";
  var age = daysSince(CFG.asOf);
  if (age >= STALE_DAYS)
    notes +=
      '<div class="warn">Built-in budgets are ' + age + " days old (as of " + esc(CFG.asOf) +
      "). Check any that changed and type the current number in the Budget column.</div>";
  errEl.innerHTML = notes;

  var spent = 0,
    budget = 0,
    atCap = 0,
    near = 0,
    noBudget = 0;
  rows.forEach(function (r) {
    spent += r.spend;
    budget += r.bud;
    if (r.pct != null && r.pct >= 100) atCap++;
    else if (r.pct != null && r.pct >= 75) near++;
    if (r.bud <= 0 && r.spend > 0) noBudget++;
  });
  sumEl.innerHTML =
    "<div><b>" + money(spent) + "</b>spent today</div>" +
    "<div><b>" + money(budget) + "</b>daily budgets</div>" +
    "<div><b>" + atCap + "</b>at 100%+</div>" +
    "<div><b>" + near + "</b>at 75-99%</div>" +
    (noBudget ? '<div><b style="color:#e0a93b">' + noBudget + "</b>no budget set</div>" : "");

  logEl.textContent = logLines.join("\n");

  document.title = (atCap ? "(" + atCap + " at 100%) " : "") + document.title.replace(/^\(\d+ at 100%\) /, "");

  if (isEditing()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  rowsEl.innerHTML =
    rows
      .map(function (r) {
        var cls = paceClass(r.pct);
        var width = r.pct == null ? 0 : Math.min(100, r.pct);
        var label = esc(r.name) + "<small>#" + esc(r.id) + "</small>";
        var nameCell = r.link
          ? '<a class="nm lnk" href="' + esc(r.link) + '" target="_blank" rel="noopener" title="Open ' + esc(r.name) + ' in GOAL">' + label + "</a>"
          : '<div class="nm" title="' + esc(r.name) + '">' + label + "</div>";
        return (
          "<tr><td>" + nameCell +
          '<div class="bar ' + cls + '"><i style="width:' + width.toFixed(1) + '%"></i></div></td>' +
          '<td class="r">' + money(r.spend) + "</td>" +
          '<td class="r"><input class="bud' + (r.over ? " ov" : "") + '" inputmode="decimal" data-id="' + esc(r.id) +
          '" value="' + (r.bud > 0 || r.over ? r.bud : "") + '" placeholder="set" title="' +
          (r.over ? "Your saved budget. Clear it to go back to the built-in number." : "Today's daily budget. Type a number to override it on this computer.") +
          '"></td>' +
          '<td class="r"><span class="pct ' + cls + '">' + (r.pct == null ? "no budget" : Math.round(r.pct) + "%") + "</span></td></tr>"
        );
      })
      .join("") ||
    '<tr><td colspan="4" style="color:#7c7f86;padding:16px 10px">' + (lastCheck ? "No spend yet today." : "Loading...") + "</td></tr>";
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(function () {
    if (running) poll();
  }, 60000 * S.every);
}

// Background tabs throttle timers; catch up as soon as the tab is visible again.
function onVisible() {
  if (document.visibilityState === "visible" && running && !stopped && Date.now() - lastAttempt > 60000 * S.every) poll();
}

function setIcon() {
  if (!ICON) return;
  try {
    var link = document.querySelector('link[rel~="icon"]');
    prevIcon = link ? { el: link, href: link.getAttribute("href") } : null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.setAttribute("data-bpw", "1");
      document.head.appendChild(link);
    }
    link.href = ICON;
  } catch (e) {}
}

function restoreIcon() {
  try {
    var added = document.querySelector('link[rel~="icon"][data-bpw]');
    if (added) added.remove();
    else if (prevIcon && prevIcon.el) prevIcon.el.setAttribute("href", prevIcon.href || "");
  } catch (e) {}
}

function open() {
  if (stopped) return;
  build();
  minimized = false;
  panel.classList.remove("min");
  render();
}

function stop() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  if (panel) panel.remove();
  if (styleEl) styleEl.remove();
  panel = styleEl = null;
  if (audio && audio.close) audio.close().catch(function () {});
  restoreIcon();
  document.title = document.title.replace(/^\(\d+ at 100%\) /, "");
  delete window.__bpw;
}

/* ---------- start ---------- */

window.__bpw = {
  poll: poll,
  stop: stop,
  open: open,
  state: function () {
    return { rows: rows, settings: S, fired: fired, config: CFG };
  },
};

initAudio();
build();
setIcon();
document.addEventListener("visibilitychange", onVisible);
if ("Notification" in window && Notification.permission === "default") {
  try {
    Notification.requestPermission().then(updatePermission);
  } catch (e) {}
}
log("Watching " + Object.keys(ACCOUNTS).length + " accounts. Budgets as of " + CFG.asOf + "; edit any budget inline.");
render();
poll();
schedule();
