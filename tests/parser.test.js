import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  extractPrintedId,
  normalizePrintedId,
  parseSearchHtml,
  parseSearchResults,
} from "../src/core/parser.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("parses the exact available product fixture", () => {
  const report = parseSearchResults(fixture("search-exact.html"));
  assert.equal(report.structureError, false);
  assert.equal(report.cardProductCount, 1);
  assert.equal(report.products.length, 1);
  assert.deepEqual(report.products[0], {
    printedId: "Kka/W102-005SEC",
    normalizedId: "kka/w102-005sec",
    name: "小さな奇跡の物語 あゆ(サイン入り)",
    gid: "7",
    ver: "key2.0",
    cid: "10190",
    kizu: "0",
    condition: "normal",
    stock: 1,
    limit: 1,
    priceYen: 12800,
    detailUrl: "/sell/ws/card/key2.0/10190",
    cartActive: 1,
    cartLimit: 1,
    soldOut: false,
    available: true,
  });
});

test("parses damaged products when kizu is non-zero", () => {
  const report = parseSearchResults(fixture("search-with-damaged.html"));
  assert.equal(report.structureError, false);
  assert.equal(report.products.length, 2);
  const damaged = report.products.find((p) => p.condition === "damaged");
  assert.ok(damaged);
  assert.equal(damaged.kizu, "1");
  assert.equal(damaged.priceYen, 10000);
  assert.equal(damaged.stock, 3);
});

test("uses the card image alt when the visible ID span is absent", () => {
  const html = `
    <div class="card-product">
      <img class="card" alt="DCT/S86-001SP Character">
      <h4>Alt fallback</h4><strong>1,000円</strong>
      <a href="/sell/ws/card/ver/1"></a>
      <input class="cart_gid" value="7"><input class="cart_ver" value="ver">
      <input class="cart_cid" value="1"><input class="cart_kizu" value="0">
      <input class="cart_limit" value="3"><input class="cart_active" value="2">
    </div>`;
  const products = parseSearchHtml(html);
  assert.equal(products.length, 1);
  assert.equal(products[0].printedId, "DCT/S86-001SP");
  assert.equal(products[0].stock, 2);
});

test("marks sold-out products from class and zero inventory", () => {
  const [product] = parseSearchHtml(fixture("search-sold-out.html"));
  assert.equal(product.printedId, "Kka/W102-007R");
  assert.equal(product.soldOut, true);
  assert.equal(product.available, false);
  assert.equal(product.stock, 0);
});

test("uses the safe minimum of active stock and cart limit", () => {
  const [product] = parseSearchHtml(fixture("search-partial.html"));
  assert.equal(product.cartActive, 5);
  assert.equal(product.cartLimit, 2);
  assert.equal(product.stock, 2);
});

test("keeps duplicate exact candidates so lookup can mark them ambiguous", () => {
  const report = parseSearchResults(fixture("search-ambiguous.html"));
  assert.equal(report.products.length, 2);
  assert.equal(report.products[0].normalizedId, report.products[1].normalizedId);
});

test("rejects missing fields and reports a structure error", () => {
  const report = parseSearchResults(fixture("search-missing-fields.html"));
  assert.equal(report.products.length, 0);
  assert.equal(report.rejected[0].field, "cart_gid");
  assert.equal(report.structureError, true);
});

test("rejects malformed stock and price values", () => {
  const html = `
    <div class="card-product">
      <span>Kka/W102-011R</span><h4>Malformed</h4><strong>12.8円</strong>
      <a href="/sell/ws/card/ver/11"></a>
      <input class="cart_gid" value="7"><input class="cart_ver" value="ver">
      <input class="cart_cid" value="11"><input class="cart_kizu" value="0">
      <input class="cart_limit" value="many"><input class="cart_active" value="1">
    </div>`;
  const report = parseSearchResults(html);
  assert.equal(report.products.length, 0);
  assert.equal(report.rejected[0].field, "cart_limit");
});

test("recognizes a wholesale selector change", () => {
  const report = parseSearchResults(fixture("search-structure-changed.html"));
  assert.equal(report.products.length, 0);
  assert.equal(report.structureError, true);
});

test("normalization is case-insensitive but preserves punctuation", () => {
  assert.equal(normalizePrintedId("  Kka/W102-005SEC "), "kka/w102-005sec");
  assert.equal(extractPrintedId("card: Kka/W102-005SEC."), "Kka/W102-005SEC");
});
