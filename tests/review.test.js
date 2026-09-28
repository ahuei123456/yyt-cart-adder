import test from "node:test";
import assert from "node:assert/strict";

import { isSelectable, mergeByProduct, summarizeReview } from "../src/ui/review.js";

function row(overrides = {}) {
  return {
    originalId: "Kka/W102-005SEC",
    printedId: "Kka/W102-005SEC",
    condition: "normal",
    priceYen: 1000,
    requestedQuantity: 2,
    plannedQuantity: 2,
    stock: 5,
    status: "ready",
    selected: true,
    inputIndex: 0,
    product: { ver: "v", cid: "1", kizu: "0" },
    ...overrides,
  };
}

test("only resolved rows with stock are selectable", () => {
  assert.equal(isSelectable(row()), true);
  assert.equal(isSelectable(row({ status: "option" })), true);
  assert.equal(isSelectable(row({ status: "partial", stock: 0 })), false);
  assert.equal(isSelectable(row({ status: "missing" })), false);
  assert.equal(isSelectable(row({ status: "sold-out" })), false);
});

test("totals count selected rows by condition, price and distinct product", () => {
  const damaged = { ver: "v", cid: "1", kizu: "1" };
  const summary = summarizeReview([
    row(),
    row({ condition: "damaged", product: damaged, plannedQuantity: 1, priceYen: 500, inputIndex: 1 }),
    row({ selected: false, inputIndex: 2 }),
    row({ plannedQuantity: 0, inputIndex: 3 }),
  ]);
  assert.equal(summary.chosen.length, 2);
  assert.equal(summary.totalCards, 3);
  assert.equal(summary.normalCards, 2);
  assert.equal(summary.damagedCards, 1);
  assert.equal(summary.totalYen, 2500);
  assert.equal(summary.productCount, 2);
  assert.deepEqual(summary.overRequested, []);
  assert.deepEqual(summary.overStock, []);
});

test("a request split across rows is flagged when it adds more than was asked", () => {
  const other = { ver: "v", cid: "2", kizu: "0" };
  const rows = [row({ requestedQuantity: 2 }), row({ product: other, plannedQuantity: 1, status: "option" })];
  const [group] = summarizeReview(rows).overRequested;
  assert.equal(group.adding, 3);
  assert.equal(group.requested, 2);
  assert.deepEqual(group.rows, rows);
  // A single row can never exceed its own request.
  assert.deepEqual(summarizeReview([row({ plannedQuantity: 4 })]).overRequested, []);
});

test("lines sharing a product are flagged above its stock or 99 copies", () => {
  const overStock = summarizeReview([row({ plannedQuantity: 3 }), row({ plannedQuantity: 3, inputIndex: 1 })]).overStock;
  assert.equal(overStock.length, 1);
  assert.equal(overStock[0].adding, 6);
  assert.equal(overStock[0].max, 5);

  const overLimit = summarizeReview([
    row({ stock: 200, plannedQuantity: 60 }),
    row({ stock: 200, plannedQuantity: 40, inputIndex: 1 }),
  ]).overStock;
  assert.equal(overLimit[0].max, 99);
});

test("mergeByProduct sums rows for one product without changing the originals", () => {
  const first = row({ plannedQuantity: 2 });
  const second = row({ plannedQuantity: 1, inputIndex: 1 });
  const third = row({ product: { ver: "v", cid: "2", kizu: "0" }, plannedQuantity: 4 });
  const merged = mergeByProduct([first, second, third]);
  assert.deepEqual(merged.map((item) => item.plannedQuantity), [3, 4]);
  assert.equal(first.plannedQuantity, 2);
});
