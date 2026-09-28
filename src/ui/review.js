/**
 * Pure calculations behind the review screen, kept apart from the DOM so
 * they can be tested directly.
 */
import { productKey } from "../core/lookup.js";

/** YYT's per-product cart limit. */
export const MAX_COPIES = 99;

export function isSelectable(row) {
  return ["ready", "partial", "option"].includes(row.status) && (row.stock ?? 0) > 0;
}

/** Rows that will add at least one copy. */
export function chosenRows(rows) {
  return rows.filter((row) => row.selected && row.plannedQuantity > 0);
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

const adding = (rows) => rows.filter((row) => row.selected).reduce((n, row) => n + (row.plannedQuantity || 0), 0);

/**
 * Totals for the selected rows, plus the groups of rows that together add
 * too much:
 * - `overRequested`: one input line split across conditions or rarities adds
 *   more copies than it asked for.  A warning only.
 * - `overStock`: different lines resolve to the same product and together
 *   exceed its stock or the 99-copy limit, which each row alone is capped at.
 *   This blocks the batch.
 */
export function summarizeReview(rows) {
  const chosen = chosenRows(rows);
  const cards = (list) => list.reduce((n, row) => n + row.plannedQuantity, 0);
  const totalCards = cards(chosen);
  const damagedCards = cards(chosen.filter((row) => row.condition === "damaged"));

  const overRequested = groupBy(rows, (row) => (Number.isInteger(row.inputIndex) ? row.inputIndex : null))
    .map((group) => ({ rows: group, adding: adding(group), requested: group[0].requestedQuantity || 0 }))
    .filter((group) => group.rows.length > 1 && group.adding > group.requested);

  const overStock = groupBy(rows, (row) => productKey(row.product))
    .map((group) => ({ rows: group, adding: adding(group), max: Math.min(MAX_COPIES, ...group.map((row) => row.stock ?? 0)) }))
    .filter((group) => group.rows.length > 1 && group.adding > group.max);

  return {
    chosen,
    totalCards,
    damagedCards,
    normalCards: totalCards - damagedCards,
    totalYen: chosen.reduce((n, row) => n + (row.priceYen || 0) * row.plannedQuantity, 0),
    productCount: new Set(chosen.map((row) => productKey(row.product) ?? row)).size,
    overRequested,
    overStock,
  };
}

/** Merge chosen rows that resolve to the same product into one cart item. */
export function mergeByProduct(chosen) {
  const byProduct = new Map();
  for (const row of chosen) {
    const key = productKey(row.product) ?? row;
    const merged = byProduct.get(key);
    if (merged) merged.plannedQuantity += row.plannedQuantity;
    else byProduct.set(key, { ...row });
  }
  return [...byProduct.values()];
}
