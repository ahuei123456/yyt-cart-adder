// Checks the live site still works with the script: a known card must resolve
// and /top/ws must expose a CSRF token.  Run on a schedule by CI so a change
// to YYT's markup shows up before it breaks a real order.
import { Window } from "happy-dom";
import { getCsrfToken } from "../src/core/cart.js";
import { lookupProducts } from "../src/core/lookup.js";

const origin = "https://yuyu-tei.jp";
const cardId = "Kka/W102-005SEC";
globalThis.DOMParser = new Window().DOMParser;

const { rows } = await lookupProducts([cardId], { origin });
const broken = rows.filter((row) => ["missing", "ambiguous", "error"].includes(row.status));
if (broken.length || !rows.length) {
  console.error(`${cardId} did not resolve:`, broken.map((row) => row.errorMessage ?? row.reason));
  process.exit(1);
}
console.log(`${cardId}: ${rows.map((row) => `${row.condition} ${row.status}, ¥${row.priceYen}`).join("; ")}`);

await getCsrfToken({ documentRef: null, fetch: (path, init) => fetch(new URL(path, origin), init) });
console.log("CSRF token found on /top/ws");
