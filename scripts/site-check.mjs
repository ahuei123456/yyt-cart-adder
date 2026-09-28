// Checks the live site still works with the script.  Run on a schedule by CI
// so a change to YYT's markup shows up before it breaks a real order:
// - every card on two prefix pages parses, damaged copies included;
// - a known card resolves;
// - an ID sold in two rarities still reads as two rarities;
// - /top/ws exposes a CSRF token.
import { Window } from "happy-dom";
import { getCsrfToken } from "../src/core/cart.js";
import { fetchSearchPage, lookupProducts } from "../src/core/lookup.js";
import { parseSearchResults } from "../src/core/parser.js";

const origin = "https://yuyu-tei.jp";
const cardId = "Kka/W102-005SEC";
const dualRarityId = "RZ/SE35-01";
globalThis.DOMParser = new Window().DOMParser;

const failures = [];

for (const prefix of ["Kka/W102", "RZ/SE35"]) {
  const { html } = await fetchSearchPage(prefix, { origin });
  const { products, rejected, cardProductCount } = parseSearchResults(html);
  const damaged = products.filter((product) => product.condition === "damaged").length;
  console.log(`${prefix}: ${products.length} of ${cardProductCount} cards parsed, ${damaged} damaged`);
  if (!products.length || rejected.length) {
    failures.push(`${prefix}: ${rejected.length} cards could not be read (${[...new Set(rejected.map((r) => r.reason))].join(", ")})`);
  }
}

const { rows, candidatesById } = await lookupProducts([cardId, dualRarityId], { origin, delayMs: 1_000 });
const broken = rows.filter((row) => row.originalId === cardId && ["missing", "ambiguous", "error"].includes(row.status));
if (broken.length || !rows.some((row) => row.originalId === cardId)) {
  failures.push(`${cardId} did not resolve: ${broken.map((row) => row.errorMessage ?? row.reason).join(", ")}`);
} else {
  const found = rows.filter((row) => row.originalId === cardId);
  console.log(`${cardId}: ${found.map((row) => `${row.condition} ${row.status}, ¥${row.priceYen}`).join("; ")}`);
}

const rarities = new Set((candidatesById.get(dualRarityId.toLowerCase()) ?? []).map((product) => product.rarity));
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
