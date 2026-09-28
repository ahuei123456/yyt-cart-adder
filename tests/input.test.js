import test from "node:test";
import assert from "node:assert/strict";
import { parseInput } from "../src/core/input.js";
import { buildLookupPlan, getSearchPrefix } from "../src/core/lookup.js";
import { normalizePrintedId } from "../src/core/parser.js";
import { ERROR_CODES } from "../src/core/errors.js";

test("normalizes IDs without removing punctuation or rarity suffixes", () => {
  assert.equal(normalizePrintedId("  Kka/W102-005SEC  "), "kka/w102-005sec");
  assert.equal(normalizePrintedId("Kka/W102-005"), "kka/w102-005");
  assert.notEqual(normalizePrintedId("Kka/W102-005SEC"), normalizePrintedId("Kka/W102-005"));
});

test("gets a conservative prefix before the first hyphen", () => {
  assert.equal(getSearchPrefix("Kka/W102-005SEC"), "Kka/W102");
  assert.equal(getSearchPrefix("  kka/w102-005  "), "kka/w102");
  assert.equal(getSearchPrefix("NoHyphen"), null);
  assert.equal(getSearchPrefix("NoSlash-005"), null);
  assert.equal(getSearchPrefix("Bad Prefix-005"), null);
});

test("parses space, comma, tab, and omitted quantity forms", () => {
  const result = parseInput([
    "Kka/W102-005SEC 2",
    "Kka/W102-006SP,3",
    "Kka/W102-007RR\t4",
    "Kka/W102-008R",
  ].join("\n"));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.requests, [
    {
      originalIds: ["Kka/W102-005SEC"],
      normalizedId: "kka/w102-005sec",
      requestedQuantity: 2,
      sourceLines: [1],
    },
    {
      originalIds: ["Kka/W102-006SP"],
      normalizedId: "kka/w102-006sp",
      requestedQuantity: 3,
      sourceLines: [2],
    },
    {
      originalIds: ["Kka/W102-007RR"],
      normalizedId: "kka/w102-007rr",
      requestedQuantity: 4,
      sourceLines: [3],
    },
    {
      originalIds: ["Kka/W102-008R"],
      normalizedId: "kka/w102-008r",
      requestedQuantity: 1,
      sourceLines: [4],
    },
  ]);
});

test("ignores blank lines and comments", () => {
  const result = parseInput("\n  # comment\n\t# another comment\nKka/W102-005SEC");
  assert.deepEqual(result.errors, []);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.requests[0].sourceLines, [4]);
});

test("aggregates duplicate IDs case-insensitively and tracks source lines", () => {
  const result = parseInput([
    "Kka/W102-005SEC 2",
    "kka/w102-005sec,3",
    "KKA/W102-005SEC\t1",
  ].join("\n"));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.requests, [{
    originalIds: ["Kka/W102-005SEC", "kka/w102-005sec", "KKA/W102-005SEC"],
    normalizedId: "kka/w102-005sec",
    requestedQuantity: 6,
    sourceLines: [1, 2, 3],
  }]);
});

test("reports invalid quantities and extra tokens with line numbers", () => {
  const result = parseInput([
    "Kka/W102-001R 0",
    "Kka/W102-002R -1",
    "Kka/W102-003R 1.5",
    "Kka/W102-004R nope",
    "Kka/W102-005R 100",
    "Kka/W102-006R 1 extra",
    "Kka/W102-007R,1,2",
  ].join("\n"));

  assert.equal(result.requests.length, 0);
  assert.equal(result.errors.length, 7);
  assert.deepEqual(result.errors.map((error) => error.lineNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(result.errors.every((error) => error.code === ERROR_CODES.INPUT_INVALID));
});

test("rejects IDs containing whitespace and keeps malformed IDs out of requests", () => {
  const result = parseInput("Kka/W102 001R 1\nKka/W102-002R 1");
  assert.equal(result.requests.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].lineNumber, 1);
  assert.equal(result.errors[0].code, ERROR_CODES.INPUT_INVALID);
});

test("marks duplicate aggregate overflow invalid", () => {
  const result = parseInput("Kka/W102-005SEC 98\nkka/w102-005sec 2");
  assert.deepEqual(result.requests, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, ERROR_CODES.INPUT_INVALID);
  assert.deepEqual(result.errors[0].lineNumbers, [1, 2]);
  assert.match(result.errors[0].message, /maximum of 99/);
});

test("groups shared prefixes into one query and separates fallback IDs", () => {
  const { requests } = parseInput([
    "Kka/W102-005SEC 1",
    "KKA/W102-006SP 2",
    "SMP/W99-001R 1",
    "UnusualCard 1",
  ].join("\n"));

  const plan = buildLookupPlan(requests);
  assert.deepEqual([...plan.groups.keys()], ["Kka/W102", "SMP/W99"]);
  assert.equal(plan.groups.get("Kka/W102").length, 2);
  assert.equal(plan.groups.get("SMP/W99").length, 1);
  assert.deepEqual(plan.fallbackIds.map((request) => request.normalizedId), ["unusualcard"]);
});

test("grouping preserves request and group order", () => {
  const { requests } = parseInput([
    "SMP/W99-001R",
    "Kka/W102-005SEC",
    "SMP/W99-002R",
    "Kka/W102-006SP",
  ].join("\n"));
  const plan = buildLookupPlan(requests);
  assert.deepEqual([...plan.groups.keys()], ["SMP/W99", "Kka/W102"]);
  assert.deepEqual(plan.groups.get("SMP/W99").map((request) => request.normalizedId), [
    "smp/w99-001r",
    "smp/w99-002r",
  ]);
});

test("unusual request objects are sent through exact fallback", () => {
  const request = {
    originalIds: ["strange"],
    normalizedId: "strange",
    requestedQuantity: 1,
    sourceLines: [1],
  };
  const plan = buildLookupPlan([request]);
  assert.equal(plan.groups.size, 0);
  assert.deepEqual(plan.fallbackIds, [request]);
});

test("parses damaged condition tokens in various delimiters", () => {
  const result = parseInput([
    "Kka/W102-005SEC 1 damaged",
    "Kka/W102-006SP,2,damaged",
    "Kka/W102-007RR 3 1",
    "Kka/W102-008R 4,damaged",
    "Kka/W102-009R damaged",
    "Kka/W102-010R 2 normal",
    "Kka/W102-011R 1 0",
  ].join("\n"));

  assert.deepEqual(result.errors, []);
  assert.equal(result.requests.length, 7);
  assert.deepEqual(result.requests[0], {
    originalIds: ["Kka/W102-005SEC"],
    normalizedId: "kka/w102-005sec",
    requestedQuantity: 1,
    sourceLines: [1],
    condition: "damaged",
  });
  assert.equal(result.requests[1].condition, "damaged");
  assert.equal(result.requests[1].requestedQuantity, 2);
  assert.equal(result.requests[2].condition, "damaged");
  assert.equal(result.requests[2].requestedQuantity, 3);
  assert.equal(result.requests[3].condition, "damaged");
  assert.equal(result.requests[3].requestedQuantity, 4);
  assert.equal(result.requests[4].condition, "damaged");
  assert.equal(result.requests[4].requestedQuantity, 1);
  assert.equal(result.requests[5].condition, "normal");
  assert.equal(result.requests[5].requestedQuantity, 2);
  assert.equal(result.requests[6].condition, "normal");
  assert.equal(result.requests[6].requestedQuantity, 1);
});

test("aggregates duplicate cards with same condition and keeps distinct conditions separate", () => {
  const result = parseInput([
    "Kka/W102-005SEC 1 damaged",
    "kka/w102-005sec 2 damaged",
    "Kka/W102-005SEC 3 normal",
  ].join("\n"));

  assert.deepEqual(result.errors, []);
  assert.equal(result.requests.length, 2);
  const damaged = result.requests.find((r) => r.condition === "damaged");
  const normal = result.requests.find((r) => r.condition === "normal");
  assert.equal(damaged.requestedQuantity, 3);
  assert.deepEqual(damaged.sourceLines, [1, 2]);
  assert.equal(normal.requestedQuantity, 3);
  assert.deepEqual(normal.sourceLines, [3]);
});

test("parses an optional uppercase rarity in any position after the quantity", () => {
  const result = parseInput([
    "RZ/SE35-01 2 S-RR",
    "RZ/SE35-02 S-RR damaged",
    "RZ/SE35-03,1,damaged,RR",
    "RZ/SE35-01 RR",
    "RZ/SE35-01,1,S-RR",
  ].join("\n"));

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.requests.map((r) => [r.normalizedId, r.requestedQuantity, r.condition ?? null, r.rarity ?? null]),
    [
      ["rz/se35-01", 3, null, "S-RR"],
      ["rz/se35-02", 1, "damaged", "S-RR"],
      ["rz/se35-03", 1, "damaged", "RR"],
      ["rz/se35-01", 1, null, "RR"],
    ],
  );
});

test("rejects lowercase or repeated rarity tokens", () => {
  const result = parseInput("RZ/SE35-01 1 s-rr\nRZ/SE35-01 1 RR SP");
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.errors.map((e) => e.lineNumber), [1, 2]);
});
