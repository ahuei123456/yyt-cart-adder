// Checks the live site still works with the script.  Run on a schedule by CI
// so a change to YYT's markup shows up before it breaks a real order:
// - every card on two prefix pages parses;
// - a damaged-copy (kizu=1) search parses and lists only damaged copies;
// - a search too big for one page links a second page, which parses too;
// - a known card resolves;
// - an ID sold in two rarities still reads as two rarities;
// - star rarities (SR★★★) are read;
// - /top/ws exposes a CSRF token.
//
// Pages are parsed with jsdom, which repairs markup the way a browser does;
// YYT's damaged-copy cards need that.
import { JSDOM } from "jsdom";
import { getCsrfToken } from "../src/core/cart.js";
import { fetchSearchPage, lookupProducts } from "../src/core/lookup.js";
import { parseSearchResults } from "../src/core/parser.js";

const origin = "https://yuyu-tei.jp";
const cardId = "Kka/W102-005SEC";
const dualRarityId = "RZ/SE35-01";
globalThis.DOMParser = new JSDOM().window.DOMParser;

const failures = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_000));

async function checkPage(label, query, page = {}) {
  const { html } = await fetchSearchPage(query, { origin }, page);
  const parsed = parseSearchResults(html);
  const { products, rejected, cardProductCount } = parsed;
  const damaged = products.filter((product) => product.condition === "damaged").length;
  console.log(`${label}: ${products.length} of ${cardProductCount} cards parsed, ${damaged} damaged, ${parsed.lastPage} page(s)`);
  if (!products.length || rejected.length) {
    failures.push(`${label}: ${rejected.length} of ${cardProductCount} cards could not be read (${[...new Set(rejected.map((r) => r.reason))].join(", ")})`);
  }
  await pause();
  return parsed;
}

for (const prefix of ["Kka/W102", "RZ/SE35"]) await checkPage(prefix, prefix);

const damaged = await checkPage("HOL damaged copies", "HOL", { condition: "damaged" });
if (damaged.products.some((product) => product.condition !== "damaged")) {
  failures.push("HOL damaged copies: the kizu=1 search listed normal copies");
}

const broad = await checkPage("HOL", "HOL");
if (broad.lastPage < 2) failures.push("HOL: expected a link to a second page of results");
else await checkPage("HOL page 2", "HOL", { page: 2 });

const stars = await checkPage("NIK/S135", "NIK/S135");
const starRarities = [...new Set(stars.products.map((product) => product.rarity).filter((rarity) => rarity?.includes("★")))];
console.log(`NIK/S135: star rarities ${starRarities.join(", ") || "none"}`);
if (!starRarities.length) failures.push("NIK/S135: no SR★ rarities were read");

const { rows, candidatesById } = await lookupProducts([cardId, dualRarityId], { origin, delayMs: 1_000 });
const broken = rows.filter((row) => row.originalId === cardId && ["missing", "error"].includes(row.status));
if (broken.length || !rows.some((row) => row.originalId === cardId)) {
  failures.push(`${cardId} did not resolve: ${broken.map((row) => row.errorMessage ?? row.reason).join(", ")}`);
} else {
  const found = rows.filter((row) => row.originalId === cardId);
  console.log(`${cardId}: ${found.map((row) => `${row.condition} ${row.status}, ¥${row.priceYen}`).join("; ")}`);
}

const rarities = new Set((candidatesById.get(dualRarityId.toLowerCase()) ?? [])
  .filter((product) => product.condition === "normal")
  .map((product) => product.rarity));
console.log(`${dualRarityId}: rarities ${[...rarities].join(", ") || "none"}`);
if (rarities.size < 2 || rarities.has(null)) {
  failures.push(`${dualRarityId} should list two labelled rarities, found: ${[...rarities].join(", ") || "none"}`);
}

try {
  await getCsrfToken({ documentRef: null, fetch: (path, init) => fetch(new URL(path, origin), init) });
  console.log("CSRF token found on /top/ws");
} catch (error) {
  failures.push(`CSRF token: ${error.message}`);
}

if (failures.length) {
  console.error(`\nSite check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
