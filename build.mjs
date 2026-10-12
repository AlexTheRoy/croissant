#!/usr/bin/env node
/*
 * Builds dist/index.html (the installer page) and dist/bookmarklet.txt.
 *
 *   node build.mjs                       uses ./accounts.json
 *   node build.mjs --config path.json    uses another data file
 *
 * accounts.json holds client data and is gitignored. See accounts.example.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minify } from "terser";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const configPath = resolve(flag("--config") || resolve(root, "accounts.json"));
const outDir = resolve(flag("--out") || resolve(root, "dist"));

if (!existsSync(configPath)) {
  console.error(
    `No account data at ${configPath}.\n` +
      `Copy accounts.example.json to accounts.json and fill in your accounts, or pass --config <file>.`
  );
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  console.error(`${configPath} is not valid JSON: ${e.message}`);
  process.exit(1);
}
validate(config);

const lib = readFileSync(resolve(root, "src/lib.js"), "utf8").replace(
  /\/\* istanbul ignore next \*\/[\s\S]*$/,
  ""
);
const app = readFileSync(resolve(root, "src/bookmarklet.js"), "utf8");

// Embed config as a JSON literal. Escape "<" so names can never close a tag.
const configLiteral = JSON.stringify(config).replace(/</g, "\\u003c");
if (!app.includes("__CROISSANT_CONFIG__;")) throw new Error("Config placeholder missing from src/bookmarklet.js");
// A replacer function, so "$" in an account name is not read as a replacement pattern.
const source = `(function(){\n${lib}\n${app.replace("__CROISSANT_CONFIG__;", () => configLiteral + ";")}\n})();`;

const result = await minify(source, {
  compress: { passes: 2 },
  mangle: true,
  format: { comments: false, ascii_only: true },
});
if (!result.code) throw new Error("terser returned no code");

const bookmarklet = "javascript:" + encodeURIComponent(result.code).replace(/'/g, "%27");

const asOfLong = new Date(config.asOf + "T12:00:00Z").toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const build = new Date().toISOString().slice(0, 10);

const html = readFileSync(resolve(root, "src/installer.html"), "utf8")
  .split("{{BOOKMARKLET}}").join(bookmarklet)
  .split("{{AS_OF_LONG}}").join(asOfLong)
  .split("{{AS_OF}}").join(config.asOf)
  .split("{{COUNT}}").join(String(Object.keys(config.accounts).length))
  .split("{{BUILD}}").join(build);

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), html);
writeFileSync(resolve(outDir, "bookmarklet.txt"), bookmarklet + "\n");

console.log(
  `Built ${Object.keys(config.accounts).length} accounts (as of ${config.asOf}) -> ${outDir}/index.html ` +
    `(${(bookmarklet.length / 1024).toFixed(1)} KB bookmarklet)`
);

function validate(c) {
  const problems = [];
  const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(c)) c = {};
  const asOf = typeof c.asOf === "string" ? c.asOf : "";
  // Round-trip through Date so impossible dates like 2026-13-45 are rejected too.
  const parsed = new Date(asOf + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || isNaN(parsed) || parsed.toISOString().slice(0, 10) !== asOf)
    problems.push('"asOf" must be a real date, YYYY-MM-DD');
  if (c.timezone != null) {
    try {
      if (typeof c.timezone !== "string") throw new Error("not a string");
      new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
    } catch {
      problems.push(`"timezone" ${JSON.stringify(c.timezone)} is not a valid IANA zone`);
    }
  }
  if (c.accountManagerId != null && typeof c.accountManagerId !== "number")
    problems.push('"accountManagerId" must be a number or null');
  if (!isObject(c.accounts)) problems.push('"accounts" must be an object keyed by account id');
  for (const [id, a] of Object.entries(isObject(c.accounts) ? c.accounts : {})) {
    if (!/^\d+$/.test(id)) problems.push(`account id "${id}" should be numeric`);
    if (!a || typeof a.name !== "string" || !a.name) problems.push(`#${id}: missing "name"`);
    if (!Array.isArray(a?.budgets) || a.budgets.length !== 7 || a.budgets.some((b) => typeof b !== "number" || b < 0))
      problems.push(`#${id}: "budgets" must be 7 non-negative numbers, Sun..Sat`);
    if (a?.brandId != null && typeof a.brandId !== "number") problems.push(`#${id}: "brandId" must be a number or null`);
  }
  if (problems.length) {
    console.error(configPath + " has problems:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
}
