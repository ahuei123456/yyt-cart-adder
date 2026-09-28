import { parseInput } from "./core/input.js";
import { lookupProducts } from "./core/lookup.js";
import { addCartItems, DEFAULT_CART_DELAY_MS } from "./core/cart.js";
import { mountApp } from "./ui/app.js";

function uiRow(row) {
  const product = row.product;
  return {
    ...row,
    requestedId: row.originalIds?.[0] ?? row.originalId ?? row.normalizedId,
    printedId: row.canonicalPrintedId ?? product?.printedId ?? null,
    stock: row.availableStock,
    gid: product?.gid,
    ver: product?.ver,
    cid: product?.cid,
    kizu: row.kizu ?? product?.kizu,
    condition: row.condition ?? product?.condition ?? (product?.kizu === "0" ? "normal" : "damaged"),
    limit: product?.limit,
  };
}

mountApp({
  parse: parseInput,
  async resolve(requests, options = {}) {
    const resolved = await lookupProducts(requests, {
      signal: options.signal,
      delayMs: 250,
      conditionPreference: options.conditionPreference,
      onProgress: options.onProgress,
    });
    return resolved.rows.map(uiRow);
  },
  addItems(rows, options = {}) {
    return addCartItems(rows, {
      isCancelled: options.isCancelled,
      onProgress: options.onProgress,
      delayMs: DEFAULT_CART_DELAY_MS,
    });
  },
});
