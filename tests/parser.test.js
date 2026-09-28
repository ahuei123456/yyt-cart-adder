import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  extractPrintedId,
  normalizePrintedId,
  normalizeRarity,
  parseSearchResults,
} from "../src/core/parser.js";

const parseSearchHtml = (html) => parseSearchResults(html).products;

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
    rarity: null,
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

test("parses damaged products from YYT's damaged-copy markup", () => {
  const report = parseSearchResults(fixture("search-damaged-copies.html"));
  assert.equal(report.structureError, false);
  assert.deepEqual(report.rejected, []);
  assert.equal(report.products.length, 1);
  const [damaged] = report.products;
  assert.equal(damaged.condition, "damaged");
  assert.equal(damaged.kizu, "1");
  assert.equal(damaged.rarity, "SEC");
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

test("reads rarity from the image alt for IDs sold in two rarities", () => {
  const report = parseSearchResults(fixture("search-dual-rarity.html"));
  assert.equal(report.structureError, false);
  assert.deepEqual(
    report.products.map((p) => [p.printedId, p.rarity, p.cid]),
    [
      ["RZ/SE35-02SP", "SP", "10101"],
      ["RZ/SE35-01", "RR", "10001"],
      ["RZ/SE35-02", "RR", "10003"],
      ["RZ/SE35-30", "C", "10059"],
      ["RZ/SE35-01", "S-RR", "10002"],
      ["RZ/SE35-02", "S-RR", "10004"],
    ],
  );
});

test("falls back to the Card List heading when the alt has no rarity", () => {
  const card = (cid) => `
    <div class="card-product">
      <a href="/sell/ws/card/rzext1.0/${cid}"><img class="card" alt="RZ/SE35-01 エミリア"></a>
      <span class="border">RZ/SE35-01</span><h4>エミリア</h4><strong>420 円</strong>
      <input class="cart_gid" value="7"><input class="cart_ver" value="rzext1.0"><input class="cart_cid" value="${cid}"><input class="cart_kizu" value="0"><input class="cart_limit" value="1"><input class="cart_active" value="1">
    </div>`;
  const html = `
    <h3><span>RR</span> Card List</h3>${card("10001")}
    <h3><span>S-RR</span> Card List</h3>${card("10002")}`;
  assert.deepEqual(parseSearchHtml(html).map((p) => p.rarity), ["RR", "S-RR"]);
});

test("reads YYT's star, symbol and no-rarity labels", () => {
  for (const [label, expected] of [
    ["SR★★★", "SR★★★"],
    ["SR**", "SR★★"],
    ["sr☆", "SR★"],
    ["SR＊＊", "SR★★"],
    ["M@P", "M@P"],
    ["Cu", "CU"],
    ["RRR+", "RRR+"],
    ["-", "-"],
    ["LUXO", "LUXO"],
    ["SR★★★★", null],
    ["エミリア", null],
  ]) {
    assert.equal(normalizeRarity(label), expected, label);
  }
  const card = (cid) => `
    <div class="card-product">
      <a href="/sell/ws/card/nik/${cid}"><img class="card" alt="NIK/S135-001S カード"></a>
      <span class="border">NIK/S135-001S</span><h4>カード</h4><strong>980 円</strong>
      <input class="cart_gid" value="7"><input class="cart_ver" value="nik"><input class="cart_cid" value="${cid}"><input class="cart_kizu" value="0"><input class="cart_limit" value="1"><input class="cart_active" value="1">
    </div>`;
  const html = `<h3>SR★★★ Card List</h3>${card("1")}<h3>SR★ Card List</h3>${card("2")}`;
  assert.deepEqual(parseSearchHtml(html).map((p) => p.rarity), ["SR★★★", "SR★"]);
});

test("reports the last result page a search links to", () => {
  const link = (page) => `<a href="https://yuyu-tei.jp/sell/ws/s/search?search_word=HOL&page=${page}">${page}</a>`;
  assert.equal(parseSearchResults(fixture("search-exact.html")).lastPage, 1);
  assert.equal(parseSearchResults(fixture("search-exact.html") + link(2) + link(3) + link(2)).lastPage, 3);
});
