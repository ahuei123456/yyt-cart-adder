import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LookupError,
  buildLookupPlan,
  groupIdsByPrefix,
  getSearchPrefix,
  lookupCards,
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

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("search_word");
    calls.push(query);
    const route = routes[query] ?? routes.default;
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route(query, calls.length);
    return response(route ?? fixture("search-empty.html"));
  };
  return { fetch, calls };
}

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
  assert.deepEqual(plan.prefixQueries, ["Kka/W102"]);
  assert.deepEqual(plan.fallbackIds, ["unusual-id"]);
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

  assert.deepEqual(mock.calls, ["Kka/W102"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[0].plannedQuantity, 1);
  assert.equal(result.rows[1].status, "partial");
  assert.equal(result.rows[1].availableStock, 4);
  assert.equal(result.rows[1].plannedQuantity, 4);
});

test("falls back to exact search for an ID absent from the prefix page", async () => {
  const mock = fakeFetch({
    "Kka/W102": fixture("search-prefix.html"),
    "Kka/W102-011R": fixture("search-empty.html"),
  });
  const result = await lookupCards(
    [
      "Kka/W102-005SEC",
      "Kka/W102-011R",
    ],
    { fetch: mock.fetch, delayMs: 0 },
  );

  assert.deepEqual(mock.calls, ["Kka/W102", "Kka/W102-011R"]);
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[1].status, "missing");
});

test("marks duplicate exact candidates ambiguous", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-ambiguous.html") });
  const result = await lookupProducts(
    ["Kka/W102-009R"],
    { fetch: mock.fetch, delayMs: 0 },
  );
  assert.equal(result.rows[0].status, "ambiguous");
  assert.equal(result.rows[0].candidates.length, 2);
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

test("stops with a stable site-change error for malformed result markup", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-structure-changed.html") });
  await assert.rejects(
    lookupProducts(["Kka/W102-005SEC"], { fetch: mock.fetch, delayMs: 0 }),
    (error) => error instanceof LookupError && error.code === "LOOKUP_SITE_CHANGED",
  );
});

test("retries transient search failures but does not retry definite client errors", async () => {
  let attempts = 0;
  const transient = {
    fetch: async () => {
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
    fetch: async () => {
      badAttempts += 1;
      return response("bad", 404);
    },
  };
  await assert.rejects(
    lookupProducts(["Kka/W102-005SEC"], {
      fetch: bad.fetch,
      delayMs: 0,
      retryBaseMs: 0,
    }),
    (error) => error.code === "LOOKUP_HTTP" && error.status === 404,
  );
  assert.equal(badAttempts, 1);
});

test("allocates condition quantities based on prefer-damaged preference", async () => {
  const mock = fakeFetch({ "Kka/W102": fixture("search-with-damaged.html") });
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
  const mock = fakeFetch({ "Kka/W102": fixture("search-with-damaged.html") });
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
  const mock = fakeFetch({ "Kka/W102": fixture("search-with-damaged.html") });
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
