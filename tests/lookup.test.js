import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLookupPlan,
  groupIdsByPrefix,
  getSearchPrefix,
  lookupProducts,
} from "../src/core/lookup.js";

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function response(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() {
      return html;
    },
  };
}

/**
 * Routes are keyed by search word; `word [damaged]` answers the kizu=1 search
 * for damaged copies and `word [page 2]` a later page.  A damaged search with
 * no route of its own finds nothing.
 */
function searchKey(url) {
  const params = new URL(url).searchParams;
  return [
    params.get("search_word"),
    params.get("kizu") === "1" ? "[damaged]" : null,
    params.get("page") ? `[page ${params.get("page")}]` : null,
  ].filter(Boolean).join(" ");
}

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    const query = searchKey(url);
    calls.push(query);
    const route = routes[query] ?? (query.includes("[damaged]") ? undefined : routes.default);
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route(query, calls.length);
    return response(route ?? fixture("search-empty.html"));
  };
  return { fetch, calls };
}

const isDamagedSearch = (url) => new URL(url).searchParams.get("kizu") === "1";

// Kka/W102-005SEC with 2 normal copies at 12,800 and 3 damaged at 10,000.
const conditionRoutes = () => ({
  "Kka/W102": fixture("search-normal-copies.html"),
  "Kka/W102 [damaged]": fixture("search-damaged-copies.html"),
});

test("groups shared prefixes into one query and sends unusual IDs to fallback", () => {
  const groups = groupIdsByPrefix([
    "Kka/W102-005SEC",
    "kka/w102-006R",
    "unusual-id",
  ]);
  assert.equal(groups.size, 1);
  assert.deepEqual([...groups.keys()], ["Kka/W102"]);
  assert.equal(groups.get("Kka/W102").length, 2);
  assert.equal(getSearchPrefix("unusual-id"), null);

  const plan = buildLookupPlan(["Kka/W102-005SEC", "unusual-id"]);
  assert.deepEqual([...plan.groups.keys()], ["Kka/W102"]);
  assert.deepEqual(plan.fallbackIds, ["unusual-id"]);
});

test("reports each search as it starts, per phase", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-prefix.html") });
  const progress = [];
  await lookupProducts(
    [
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1 },
      { originalId: "unusual-id", requestedQuantity: 1 },
    ],
    {
      fetch: mock.fetch,
      delayMs: 0,
      onProgress: (event) => {
        progress.push(event);
        throw new Error("a failing callback must not stop the lookup");
      },
    },
  );

  assert.deepEqual(progress, [
    { type: "prefix", query: "Kka/W102", condition: "normal", index: 0, total: 2 },
    { type: "prefix", query: "Kka/W102", condition: "damaged", index: 1, total: 2 },
    { type: "exact", query: "unusual-id", condition: "normal", index: 0, total: 2 },
    { type: "exact", query: "unusual-id", condition: "damaged", index: 1, total: 2 },
  ]);
});

test("performs one grouped lookup and returns exact rows", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-prefix.html") });
  const result = await lookupProducts(
    [
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1, sourceLines: [1] },
      { originalId: "Kka/W102-006R", requestedQuantity: 5, sourceLines: [2] },
    ],
    { fetch: mock.fetch, delayMs: 0 },
  );

  assert.deepEqual(mock.calls, ["Kka/W102", "Kka/W102 [damaged]"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[0].plannedQuantity, 1);
  assert.equal(result.rows[1].status, "partial");
  assert.equal(result.rows[1].stock, 4);
  assert.equal(result.rows[1].plannedQuantity, 4);
});

test("falls back to exact search for an ID absent from the prefix page", async () => {
  const mock = fakeFetch({
    "Kka/W102": fixture("search-prefix.html"),
    "Kka/W102-011R": fixture("search-empty.html"),
  });
  const result = await lookupProducts(
    [
      "Kka/W102-005SEC",
      "Kka/W102-011R",
    ],
    { fetch: mock.fetch, delayMs: 0 },
  );

  // A damaged copy missing from the prefix search is not searched for again.
  assert.deepEqual(mock.calls, ["Kka/W102", "Kka/W102 [damaged]", "Kka/W102-011R"]);
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[1].status, "missing");
});

test("offers each version of an ID sold as several products at zero", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-ambiguous.html") });
  const result = await lookupProducts(
    [{ originalId: "Kka/W102-009R", requestedQuantity: 2 }],
    { fetch: mock.fetch, delayMs: 0 },
  );
  assert.deepEqual(
    result.rows.map((r) => [r.name, r.status, r.reason, r.plannedQuantity, r.variantCount]),
    [
      ["重複候補 A", "option", "PRODUCT_VARIANT", 0, 2],
      ["重複候補 B", "option", "PRODUCT_VARIANT", 0, 2],
    ],
  );
});

test("marks sold-out candidates unselectable", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-sold-out.html") });
  const result = await lookupProducts(
    ["Kka/W102-007R"],
    { fetch: mock.fetch, delayMs: 0 },
  );
  assert.equal(result.rows[0].status, "sold-out");
  assert.equal(result.rows[0].plannedQuantity, 0);
  assert.equal(result.rows[0].selected, false);
});

test("reports malformed result markup as a site-change error on that search's rows", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-structure-changed.html") });
  const result = await lookupProducts(["Kka/W102-005SEC"], { fetch: mock.fetch, delayMs: 0 });
  assert.equal(result.rows[0].status, "error");
  assert.equal(result.rows[0].reason, "LOOKUP_SITE_CHANGED");
  assert.equal(result.rows[0].selected, false);
  // A failed prefix search is not retried card by card.
  assert.deepEqual(mock.calls, ["Kka/W102", "Kka/W102 [damaged]"]);
});

test("a failed search does not discard rows resolved by other searches", async () => {
  const mock = fakeFetch({
    "Kka/W102": fixture("search-prefix.html"),
    "SMP/W99": () => response("server", 503),
  });
  const result = await lookupProducts(
    ["Kka/W102-005SEC", "SMP/W99-001R"],
    { fetch: mock.fetch, delayMs: 0, maxRetries: 0 },
  );
  assert.deepEqual(result.rows.map((row) => row.status), ["ready", "error"]);
  assert.equal(result.rows[1].reason, "LOOKUP_HTTP");
  assert.match(result.rows[1].errorMessage, /HTTP 503/);
  assert.equal(result.queries.find((q) => q.query === "SMP/W99" && q.condition === "normal").error, "LOOKUP_HTTP");
});

test("cancelling rejects the lookup and ends the delay between searches", async () => {
  const controller = new AbortController();
  const mock = fakeFetch({ "Kka/W102": fixture("search-prefix.html") });
  const started = Date.now();
  const lookup = lookupProducts(["Kka/W102-005SEC", "SMP/W99-001R"], {
    fetch: mock.fetch,
    delayMs: 60_000,
    signal: controller.signal,
    onProgress: ({ index }) => {
      if (index === 0) setTimeout(() => controller.abort(), 0);
    },
  });
  await assert.rejects(lookup, (error) => error.name === "AbortError");
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(mock.calls, ["Kka/W102"]);
});

test("retries transient search failures but does not retry definite client errors", async () => {
  let attempts = 0;
  const transient = {
    fetch: async (url) => {
      if (isDamagedSearch(url)) return response(fixture("search-empty.html"));
      attempts += 1;
      if (attempts < 2) return response("server", 503);
      return response(fixture("search-exact.html"));
    },
  };
  const result = await lookupProducts(
    ["Kka/W102-005SEC"],
    { fetch: transient.fetch, delayMs: 0, retryBaseMs: 0 },
  );
  assert.equal(attempts, 2);
  assert.equal(result.rows[0].status, "ready");

  let badAttempts = 0;
  const bad = {
    fetch: async (url) => {
      if (isDamagedSearch(url)) return response(fixture("search-empty.html"));
      badAttempts += 1;
      return response("bad", 404);
    },
  };
  const failed = await lookupProducts(["Kka/W102-005SEC"], {
    fetch: bad.fetch,
    delayMs: 0,
    retryBaseMs: 0,
  });
  assert.equal(failed.rows[0].status, "error");
  assert.equal(failed.rows[0].reason, "LOOKUP_HTTP");
  assert.equal(failed.queries[0].status, 404);
  assert.equal(badAttempts, 1);
});

test("allocates condition quantities based on prefer-damaged preference", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [{ originalId: "Kka/W102-005SEC", requestedQuantity: 4, sourceLines: [1] }],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "prefer-damaged" },
  );

  assert.equal(result.rows.length, 2);
  const damaged = result.rows.find((r) => r.condition === "damaged");
  const normal = result.rows.find((r) => r.condition === "normal");
  assert.ok(damaged);
  assert.ok(normal);
  assert.equal(damaged.plannedQuantity, 3);
  assert.equal(damaged.selected, true);
  assert.equal(damaged.priceYen, 10000);
  assert.equal(normal.plannedQuantity, 1);
  assert.equal(normal.selected, true);
  assert.equal(normal.priceYen, 12800);
});

test("allocates condition quantities based on prefer-normal preference", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [{ originalId: "Kka/W102-005SEC", requestedQuantity: 4, sourceLines: [1] }],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "prefer-normal" },
  );

  assert.equal(result.rows.length, 2);
  const normal = result.rows.find((r) => r.condition === "normal");
  const damaged = result.rows.find((r) => r.condition === "damaged");
  assert.equal(normal.plannedQuantity, 2);
  assert.equal(normal.selected, true);
  assert.equal(damaged.plannedQuantity, 2);
  assert.equal(damaged.selected, true);
});

test("respects explicit damaged condition request while keeping normal option available", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [{ originalId: "Kka/W102-005SEC", requestedQuantity: 2, condition: "damaged", sourceLines: [1] }],
    { fetch: mock.fetch, delayMs: 0 },
  );

  assert.equal(result.rows.length, 2);
  const damaged = result.rows.find((r) => r.condition === "damaged");
  const normal = result.rows.find((r) => r.condition === "normal");
  assert.equal(damaged.plannedQuantity, 2);
  assert.equal(damaged.selected, true);
  assert.equal(normal.plannedQuantity, 0);
  assert.equal(normal.selected, false);
});

test("adds to the first listed rarity and offers the other rarity at zero", async () => {
  const mock = fakeFetch({ "RZ/SE35": fixture("search-dual-rarity.html") });
  const result = await lookupProducts(
    [{ originalId: "RZ/SE35-01", requestedQuantity: 2, sourceLines: [1] }],
    { fetch: mock.fetch, delayMs: 0 },
  );

  assert.deepEqual(
    result.rows.map((r) => [r.rarity, r.status, r.plannedQuantity, r.selected, r.stock]),
    [
      ["RR", "ready", 2, true, 7],
      ["S-RR", "option", 0, false, 1],
    ],
  );
  assert.deepEqual(result.rows[0].otherRarities, ["S-RR"]);
  assert.deepEqual(result.rows[1].otherRarities, ["RR"]);
});

test("moves the requested quantity to another rarity when the first is sold out", async () => {
  const html = fixture("search-dual-rarity.html")
    .replace(/value="7"(\s+)class="cart_limit"/, 'value="0"$1class="cart_limit"')
    .replace(/value="7"(\s+)class="cart_active"/, 'value="0"$1class="cart_active"');
  const mock = fakeFetch({ "RZ/SE35": html });
  const result = await lookupProducts(["RZ/SE35-01"], { fetch: mock.fetch, delayMs: 0 });

  assert.deepEqual(
    result.rows.map((r) => [r.rarity, r.status, r.plannedQuantity]),
    [
      ["RR", "sold-out", 0],
      ["S-RR", "ready", 1],
    ],
  );
});

test("an explicit rarity restricts matching to that rarity", async () => {
  const mock = fakeFetch({ "RZ/SE35": fixture("search-dual-rarity.html") });
  const result = await lookupProducts(
    [
      { originalId: "RZ/SE35-02", requestedQuantity: 3, rarity: "s-rr", sourceLines: [1] },
      { originalId: "RZ/SE35-01", requestedQuantity: 1, rarity: "SP", sourceLines: [2] },
    ],
    { fetch: mock.fetch, delayMs: 0 },
  );

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].rarity, "S-RR");
  assert.equal(result.rows[0].product.cid, "10004");
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[0].plannedQuantity, 3);
  assert.equal(result.rows[1].status, "missing");
  assert.equal(result.rows[1].reason, "PRODUCT_RARITY_MISSING");
});

test("IDs sold in one rarity resolve to a single row", async () => {
  const mock = fakeFetch({ "RZ/SE35": fixture("search-dual-rarity.html") });
  const result = await lookupProducts(["RZ/SE35-02SP"], { fetch: mock.fetch, delayMs: 0 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[0].otherRarities, undefined);
});

test("defaults to normal first when no preference is given", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(["Kka/W102-005SEC"], { fetch: mock.fetch, delayMs: 0 });
  assert.deepEqual(
    result.rows.map((r) => [r.condition, r.plannedQuantity, r.selected]),
    [
      ["normal", 1, true],
      ["damaged", 0, false],
    ],
  );
});

test("an -only preference still offers the other condition at zero", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [{ originalId: "Kka/W102-005SEC", requestedQuantity: 4, sourceLines: [1] }],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "normal-only" },
  );
  assert.deepEqual(
    result.rows.map((r) => [r.condition, r.status, r.reason, r.plannedQuantity]),
    [
      ["normal", "partial", "PRODUCT_PARTIAL_STOCK", 2],
      ["damaged", "option", "PRODUCT_OTHER_CONDITION", 0],
    ],
  );
});

test("a missing condition is reported with the other condition offered", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-exact.html") });
  const byPreference = await lookupProducts(
    ["Kka/W102-005SEC"],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "damaged-only" },
  );
  const byLine = await lookupProducts(
    [{ originalId: "Kka/W102-005SEC", requestedQuantity: 1, condition: "damaged" }],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "normal-only" },
  );
  for (const result of [byPreference, byLine]) {
    assert.deepEqual(
      result.rows.map((r) => [r.condition, r.status, r.reason, r.plannedQuantity]),
      [
        ["damaged", "missing", "PRODUCT_CONDITION_MISSING", 0],
        ["normal", "option", "PRODUCT_OTHER_CONDITION", 0],
      ],
    );
  }
});

test("drops option rows for products another line already resolves to", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [
      { originalId: "Kka/W102-005SEC", requestedQuantity: 4, sourceLines: [1] },
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1, condition: "damaged", sourceLines: [2] },
    ],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "normal-only" },
  );
  assert.deepEqual(
    result.rows.map((r) => [r.sourceLines[0], r.condition, r.status, r.plannedQuantity]),
    [
      [1, "normal", "partial", 2],
      [2, "damaged", "ready", 1],
    ],
  );
});

test("keeps only the first of repeated option rows", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1, sourceLines: [1] },
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1, condition: "normal", sourceLines: [2] },
    ],
    { fetch: mock.fetch, delayMs: 0, conditionPreference: "normal-only" },
  );
  assert.deepEqual(
    result.rows.map((r) => [r.sourceLines[0], r.condition, r.status]),
    [
      [1, "normal", "ready"],
      [1, "damaged", "option"],
      [2, "normal", "ready"],
    ],
  );
});

test("an unused fallback condition is shown as an option", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(["Kka/W102-005SEC"], { fetch: mock.fetch, delayMs: 0 });
  assert.deepEqual(
    result.rows.map((r) => [r.condition, r.status, r.reason, r.plannedQuantity]),
    [
      ["normal", "ready", null, 1],
      ["damaged", "option", "PRODUCT_OTHER_CONDITION", 0],
    ],
  );
});

for (const phase of ['headers', 'body']) {
  test('lookup timeout during ' + phase + ' retries within its limit', async () => {
    let calls = 0;
    const signals = [];
    const result = await lookupProducts(['Kka/W102-005SEC'], {
      timeoutMs: 10, maxRetries: 1, retryBaseMs: 0,
      fetch: async (url, init) => {
        if (isDamagedSearch(url)) return response(fixture("search-empty.html"));
        calls++;
        signals.push(init.signal);
        if (phase === 'headers') return new Promise(() => {});
        return { status: 200, ok: true, text: () => new Promise(() => {}) };
      },
    });
    assert.equal(calls, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(result.rows[0].status, 'error');
    assert.equal(result.rows[0].reason, 'LOOKUP_NETWORK');
  });
}

test("searches damaged copies separately and fills a normal shortfall from them", async () => {
  const mock = fakeFetch(conditionRoutes());
  const result = await lookupProducts(
    [{ originalId: "Kka/W102-005SEC", requestedQuantity: 4 }],
    { fetch: mock.fetch, delayMs: 0 },
  );
  assert.deepEqual(
    result.rows.map((r) => [r.condition, r.product.kizu, r.plannedQuantity, r.priceYen]),
    [
      ["normal", "0", 2, 12800],
      ["damaged", "1", 2, 10000],
    ],
  );
  assert.deepEqual(result.queries.map((q) => [q.condition, new URL(q.url).searchParams.get("kizu")]), [
    ["normal", null],
    ["damaged", "1"],
  ]);
});

test("a failed damaged search only blocks requests limited to damaged copies", async () => {
  const mock = fakeFetch({
    "Kka/W102": fixture("search-normal-copies.html"),
    "Kka/W102 [damaged]": () => response("server", 503),
  });
  const result = await lookupProducts(
    [
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1 },
      { originalId: "Kka/W102-005SEC", requestedQuantity: 1, condition: "damaged" },
    ],
    { fetch: mock.fetch, delayMs: 0, maxRetries: 0 },
  );
  assert.deepEqual(
    result.rows.map((r) => [r.condition, r.status, r.reason]),
    [
      ["normal", "ready", null],
      ["damaged", "error", "LOOKUP_HTTP"],
    ],
  );
});

test("follows a prefix search onto later result pages", async () => {
  const page = (cid, id) => `
    <div class="card-product">
      <a href="/sell/ws/card/hol/${cid}"><img class="card" alt="${id} C カード"></a>
      <span class="border">${id}</span><h4>カード</h4><strong>30 円</strong>
      <input class="cart_gid" value="7"><input class="cart_ver" value="hol"><input class="cart_cid" value="${cid}"><input class="cart_kizu" value="0"><input class="cart_limit" value="4"><input class="cart_active" value="4">
    </div>`;
  const pager = '<a href="https://yuyu-tei.jp/sell/ws/s/search?search_word=HOL%2FW91&page=2">2</a>';
  const mock = fakeFetch({
    "HOL/W91": page("10001", "HOL/W91-001") + pager,
    "HOL/W91 [page 2]": page("10200", "HOL/W91-120") + pager,
  });
  const result = await lookupProducts(["HOL/W91-001", "HOL/W91-120"], { fetch: mock.fetch, delayMs: 0 });
  assert.deepEqual(mock.calls, ["HOL/W91", "HOL/W91 [page 2]", "HOL/W91 [damaged]"]);
  assert.deepEqual(result.rows.map((r) => [r.printedId, r.status]), [
    ["HOL/W91-001", "ready"],
    ["HOL/W91-120", "ready"],
  ]);
});

test("reads star rarities and matches them from an asterisk alias", async () => {
  const card = (cid, id, rarity) => `
    <div class="card-product">
      <a href="/sell/ws/card/nik/${cid}"><img class="card" alt="${id} ${rarity} カード(サイン入り)"></a>
      <span class="border">${id}</span><h4>カード</h4><strong>980 円</strong>
      <input class="cart_gid" value="7"><input class="cart_ver" value="nik"><input class="cart_cid" value="${cid}"><input class="cart_kizu" value="0"><input class="cart_limit" value="2"><input class="cart_active" value="2">
    </div>`;
  const mock = fakeFetch({
    "NIK/S135": card("10001", "NIK/S135-001S", "SR★★★") + card("10002", "NIK/S135-001S", "SR★"),
  });
  const result = await lookupProducts(
    [{ originalId: "NIK/S135-001S", requestedQuantity: 1, rarity: "SR***" }],
    { fetch: mock.fetch, delayMs: 0 },
  );
  assert.deepEqual(result.rows.map((r) => [r.rarity, r.status, r.product.cid]), [["SR★★★", "ready", "10001"]]);
});
