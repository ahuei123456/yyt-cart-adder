import {
  normalizePrintedId,
  normalizeRarity,
  parseSearchResults,
} from "./parser.js";
import { ERROR_CODES, YytError } from "./errors.js";
import { withRequestDeadline } from "./request.js";

export const LOOKUP_ERROR_CODES = Object.freeze({
  NETWORK: ERROR_CODES.LOOKUP_NETWORK,
  HTTP: ERROR_CODES.LOOKUP_HTTP,
  SITE_CHANGED: ERROR_CODES.LOOKUP_SITE_CHANGED,
});

/**
 * Stable error type used by the lookup layer.  Consumers should branch on
 * `code`, not on arbitrary message text.
 */
export class LookupError extends YytError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = "LookupError";
    Object.assign(this, details);
  }
}

function requestId(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.originalId ?? value.originalIds?.[0] ?? "").trim();
}

function requestQuantity(value) {
  if (!value || typeof value !== "object") return 1;
  return value.requestedQuantity ?? 1;
}

function sourceLines(value) {
  const lines = value?.sourceLines;
  return Array.isArray(lines) ? lines.filter((line) => Number.isInteger(line)) : [];
}

function isValidQuantity(value) {
  return (
    (typeof value === "number" || typeof value === "string") &&
    /^\d+$/u.test(String(value).trim()) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 1 &&
    Number(value) <= 99
  );
}

function makeRequest(value, index) {
  const printedId = requestId(value);
  const normalizedId = normalizePrintedId(
    value && typeof value === "object" && value.normalizedId
      ? value.normalizedId
      : printedId,
  );
  const rawQuantity = requestQuantity(value);
  const validQuantity = isValidQuantity(rawQuantity);
  const requestedQuantity = validQuantity ? Number(rawQuantity) : Number(rawQuantity) || 0;
  const originals =
    value && typeof value === "object" && Array.isArray(value.originalIds)
      ? value.originalIds.map((id) => String(id))
      : printedId
        ? [printedId]
        : [];
  const condition =
    value && typeof value === "object" && typeof value.condition === "string"
      ? value.condition
      : null;
  const rarity =
    value && typeof value === "object" ? normalizeRarity(value.rarity) : null;

  return {
    originalId: printedId || originals[0] || String(value?.normalizedId ?? ""),
    originalIds: originals,
    normalizedId,
    ...(condition ? { condition } : {}),
    ...(rarity ? { rarity } : {}),
    requestedQuantity,
    sourceLines: sourceLines(value),
    inputIndex: index,
    invalid: !printedId || !normalizedId || !validQuantity,
    invalidReason: !printedId
      ? "missing printed ID"
      : !validQuantity
        ? "quantity must be an integer from 1 through 99"
        : null,
  };
}

function mergeRequest(existing, incoming) {
  if (!existing) return incoming;
  existing.originalIds.push(...incoming.originalIds);
  existing.sourceLines.push(...incoming.sourceLines);
  if (existing.invalid || incoming.invalid) {
    existing.invalid = true;
    existing.invalidReason = existing.invalidReason ?? incoming.invalidReason;
  }

  // Invalid quantities remain invalid, but retaining their sum makes the row
  // explainable in a review report.  A duplicate aggregate above 99 is also
  // invalid per the MVP input contract.
  existing.requestedQuantity += incoming.requestedQuantity;
  if (existing.requestedQuantity > 99) {
    existing.invalid = true;
    existing.invalidReason = "duplicate quantity total exceeds 99";
  }
  return existing;
}

function normalizeRequests(requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError("lookup requests must be an array");
  }

  const byId = new Map();
  const invalidWithoutId = [];
  requests.forEach((value, index) => {
    const request = makeRequest(value, index);
    if (!request.normalizedId) {
      invalidWithoutId.push(request);
      return;
    }
    const key = `${request.normalizedId}:${request.condition ?? ""}:${request.rarity ?? ""}`;
    const existing = byId.get(key);
    byId.set(key, mergeRequest(existing, request));
  });
  return [...byId.values(), ...invalidWithoutId];
}

/**
 * Return the safe grouped prefix for a printed ID.  IDs without a slash and a
 * dash in the expected order intentionally go to exact-search fallback.
 */
export function getSearchPrefix(value) {
  const id = requestId(value);
  const dash = id.indexOf("-");
  const slash = id.indexOf("/");
  if (dash <= 0 || slash <= 0 || slash >= dash) return null;
  const prefix = id.slice(0, dash).trim();
  if (!prefix || /\s/u.test(prefix)) return null;
  return prefix;
}

/**
 * Group input values by prefix.  Map keys preserve the first spelling used by
 * the caller, while case variants share one network query.
 */
export function groupIdsByPrefix(values) {
  if (!Array.isArray(values)) throw new TypeError("values must be an array");
  const groups = new Map();
  const canonicalKeys = new Map();

  for (const value of values) {
    const prefix = getSearchPrefix(value);
    if (!prefix) continue;
    const canonical = normalizePrintedId(prefix);
    const key = canonicalKeys.get(canonical) ?? prefix;
    canonicalKeys.set(canonical, key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

/**
 * Build the network plan without making requests.  `fallbackIds` contains
 * values that have no usable prefix; lookup also adds IDs absent from prefix
 * responses to this exact-search queue.
 */
export function buildLookupPlan(values) {
  const groups = groupIdsByPrefix(values);
  const groupedValues = new Set([...groups.values()].flat());
  return { groups, fallbackIds: values.filter((value) => !groupedValues.has(value)) };
}

function getFetch(options) {
  if (typeof options.fetch === "function") return options.fetch;
  if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  throw new LookupError(
    LOOKUP_ERROR_CODES.NETWORK,
    "No fetch implementation is available for YYT search",
  );
}

function getOrigin(options) {
  if (options.origin) return String(options.origin);
  if (typeof globalThis !== "undefined" && globalThis.location?.origin) {
    return globalThis.location.origin;
  }
  return "https://yuyu-tei.jp";
}

function makeSearchUrl(query, options) {
  const url = new URL("/sell/ws/s/search", getOrigin(options));
  url.searchParams.set("search_word", query);
  return url.toString();
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status > 0 ? status : response?.ok === false ? 0 : 200;
}

function responseOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  const status = responseStatus(response);
  return status >= 200 && status < 300;
}

function retryAfterMilliseconds(response) {
  const header = response?.headers?.get?.("Retry-After") ?? response?.headers?.["Retry-After"];
  if (header == null) return null;
  const seconds = Number.parseFloat(String(header).trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(String(header));
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  return null;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * Wait between searches.  Aborting `options.signal` ends the wait at once
 * with an AbortError, so a cancelled lookup does not sit out its delay.
 */
async function sleep(milliseconds, options) {
  if (milliseconds <= 0) return;
  if (typeof options.sleep === "function") {
    await options.sleep(milliseconds);
    return;
  }
  const signal = options.signal;
  const cancelled = () => new DOMException("The lookup was cancelled", "AbortError");
  if (signal?.aborted) throw cancelled();
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/**
 * Fetch one HTML search page.  GET lookups may retry network, 429, and 5xx
 * failures; cart mutation code must not reuse this helper for POST requests.
 */
export async function fetchSearchPage(query, options = {}) {
  const fetchFunction = getFetch(options);
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
  const retryBaseMs = Number.isFinite(options.retryBaseMs) ? Math.max(0, options.retryBaseMs) : 250;
  const url = makeSearchUrl(String(query), options);
  let attempt = 0;

  while (true) {
    let response;
    let html;
    try {
      await withRequestDeadline(async (signal) => {
        response = await fetchFunction(url, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "text/html" },
          signal,
        });
        if (responseOk(response)) html = await response.text();
      }, options);
    } catch (error) {
      if (!isAbortError(error) && attempt < maxRetries) {
        await sleep(retryBaseMs * 2 ** attempt, options);
        attempt += 1;
        continue;
      }
      throw new LookupError(
        LOOKUP_ERROR_CODES.NETWORK,
        isAbortError(error) ? "YYT search was cancelled" : "YYT search request failed",
        { cause: error, query: String(query), url },
      );
    }

    const status = responseStatus(response);
    if (!responseOk(response)) {
      if (isRetryableStatus(status) && attempt < maxRetries) {
        const retryDelay = retryAfterMilliseconds(response) ?? retryBaseMs * 2 ** attempt;
        await sleep(retryDelay, options);
        attempt += 1;
        continue;
      }
      throw new LookupError(
        LOOKUP_ERROR_CODES.HTTP,
        `YYT search returned HTTP ${status}`,
        { query: String(query), url, status },
      );
    }

    return { query: String(query), url, status, html, response };
  }
}

function matchingProducts(products, normalizedIds) {
  const byId = new Map();
  for (const product of products ?? []) {
    const printedId = product?.printedId;
    const normalizedId = product?.normalizedId ?? normalizePrintedId(printedId);
    if (!normalizedId || !normalizedIds.has(normalizedId)) continue;
    if (!byId.has(normalizedId)) byId.set(normalizedId, []);
    byId.get(normalizedId).push(product);
  }
  return byId;
}

function mergeCandidates(target, source) {
  for (const [normalizedId, products] of source) {
    if (!target.has(normalizedId)) target.set(normalizedId, []);
    target.get(normalizedId).push(...products);
  }
}

function numbersForProduct(product) {
  const active = Number(product?.cartActive ?? product?.stock);
  const limit = Number(product?.cartLimit ?? product?.limit);
  const stock = Number(product?.stock);
  const available = [active, limit, stock].filter((value) => Number.isFinite(value) && value >= 0);
  const availableStock = available.length ? Math.min(...available) : 0;
  return {
    active: Number.isFinite(active) && active >= 0 ? active : 0,
    limit: Number.isFinite(limit) && limit >= 0 ? limit : 0,
    stock: availableStock,
  };
}

function makeInvalidRow(request) {
  return {
    ...request,
    status: "invalid",
    reason: ERROR_CODES.INPUT_INVALID,
    canonicalPrintedId: null,
    product: null,
    name: "",
    priceYen: null,
    availableStock: 0,
    plannedQuantity: 0,
    selected: false,
    condition: request.condition ?? null,
  };
}

function makeMissingRow(request, reason = ERROR_CODES.PRODUCT_MISSING) {
  return {
    ...request,
    status: "missing",
    reason,
    canonicalPrintedId: null,
    product: null,
    name: "",
    priceYen: null,
    availableStock: 0,
    plannedQuantity: 0,
    selected: false,
    candidates: [],
    condition: request.condition ?? null,
  };
}

/**
 * A row whose search failed.  The failure belongs to this ID's search only;
 * rows resolved by other searches in the same lookup are still usable.
 */
function makeErrorRow(request, error) {
  return {
    ...request,
    status: "error",
    reason: error.code,
    errorMessage: error.message,
    canonicalPrintedId: null,
    product: null,
    name: "",
    priceYen: null,
    availableStock: 0,
    plannedQuantity: 0,
    selected: false,
    candidates: [],
    condition: request.condition ?? null,
  };
}

function makeAmbiguousRow(request, candidates) {
  return {
    ...request,
    status: "ambiguous",
    reason: ERROR_CODES.PRODUCT_AMBIGUOUS,
    canonicalPrintedId: null,
    product: null,
    name: "",
    priceYen: null,
    availableStock: 0,
    plannedQuantity: 0,
    selected: false,
    candidates,
    condition: request.condition ?? null,
  };
}

function buildRow(request, product, plannedQuantity, stock, statusOverride = null) {
  const soldOut = Boolean(product.soldOut) || stock <= 0;
  const status = statusOverride
    ? statusOverride
    : soldOut
      ? "sold-out"
      : plannedQuantity < request.requestedQuantity
        ? "partial"
        : "ready";
  return {
    ...request,
    status,
    reason:
      status === "ready"
        ? null
        : status === "partial"
          ? ERROR_CODES.PRODUCT_PARTIAL_STOCK
          : ERROR_CODES.PRODUCT_SOLD_OUT,
    canonicalPrintedId: product.printedId,
    rarity: product.rarity ?? null,
    condition: product.condition || (product.kizu === "0" ? "normal" : "damaged"),
    kizu: product.kizu,
    product,
    name: product.name ?? "",
    priceYen: product.priceYen ?? null,
    availableStock: stock,
    plannedQuantity,
    selected: plannedQuantity > 0,
    candidates: [product],
  };
}

function makeSingleRow(request, product, requestedQuantity) {
  const numbers = numbersForProduct(product);
  const soldOut = Boolean(product.soldOut) || numbers.stock <= 0;
  const plannedQuantity = soldOut ? 0 : Math.min(requestedQuantity, numbers.stock);
  const status =
    soldOut ? "sold-out" : plannedQuantity < requestedQuantity ? "partial" : "ready";
  return buildRow(request, product, plannedQuantity, numbers.stock, status);
}

function isResolvedRow(row) {
  return row.status === "ready" || row.status === "partial";
}

/**
 * Turn a resolved row into a zero-quantity option the user can raise in
 * review, used for the other rarity or condition of a requested ID.  Nothing
 * is added unless they do.
 */
function asOption(row, reason) {
  if (!row.product) return row;
  return {
    ...row,
    status: row.status === "sold-out" ? "sold-out" : "option",
    reason: row.status === "sold-out" ? ERROR_CODES.PRODUCT_SOLD_OUT : reason,
    plannedQuantity: 0,
    selected: false,
    isOption: true,
  };
}

export function productKey(product) {
  return product ? [product.ver, product.cid, product.kizu].join("|") : null;
}

/**
 * Two input lines for the same ID (say `ID 4` and `ID 1 damaged`) each offer
 * the other's product as an option.  Keep one row per product: drop an option
 * when another line already resolves to that product, and keep only the
 * first of repeated options.
 */
function dropDuplicateOptions(rows) {
  const resolved = new Set(rows.filter((row) => row.product && !row.isOption).map((row) => productKey(row.product)));
  const offered = new Set();
  return rows.filter((row) => {
    if (!row.isOption) return true;
    const key = productKey(row.product);
    if (resolved.has(key) || offered.has(key)) return false;
    offered.add(key);
    return true;
  });
}

function groupByRarity(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const rarity = normalizeRarity(candidate.rarity);
    if (!groups.has(rarity)) groups.set(rarity, []);
    groups.get(rarity).push(candidate);
  }
  return [...groups].map(([rarity, products]) => ({ rarity, products }));
}

/**
 * Build review rows for one request.
 *
 * Most IDs map to one rarity, so the condition logic runs unchanged.  When an
 * ID is sold in several rarities (RR and its S-RR holo, for example), the
 * requested quantity goes to the first rarity YYT lists that can fill it, and
 * every other rarity is offered as a zero-quantity row to correct in review.
 * An explicit rarity in the input restricts matching to that rarity.
 */
export function makeRows(request, candidates, options = {}) {
  if (request.invalid) return [makeInvalidRow(request)];

  const exact = candidates ?? [];
  if (exact.length === 0) {
    return [makeMissingRow(request)];
  }

  if (request.rarity) {
    const matching = exact.filter((c) => normalizeRarity(c.rarity) === request.rarity);
    if (matching.length === 0) return [makeMissingRow(request, ERROR_CODES.PRODUCT_RARITY_MISSING)];
    return makeConditionRows(request, matching, options);
  }

  const groups = groupByRarity(exact);
  if (groups.length === 1) return makeConditionRows(request, exact, options);
  // Products share an ID but at least one has no readable rarity, so there is
  // no label to tell them apart.
  if (groups.some((group) => group.rarity == null)) return [makeAmbiguousRow(request, exact)];

  const rowsByGroup = groups.map((group) => makeConditionRows(request, group.products, options));
  const primaryIndex = Math.max(0, rowsByGroup.findIndex((rows) => rows.some(isResolvedRow)));
  const rarities = groups.map((group) => group.rarity);
  return rowsByGroup.flatMap((rows, index) =>
    rows
      .filter((row) => index === primaryIndex || row.status !== "missing")
      .map((row) => ({
        ...(index === primaryIndex ? row : asOption(row, ERROR_CODES.PRODUCT_OTHER_RARITY)),
        otherRarities: rarities.filter((rarity) => rarity !== groups[index].rarity),
      })),
  );
}

function makeConditionRows(request, exact, options) {
  const normal = exact.filter((c) => String(c.kizu).trim() === "0");
  const damaged = exact.filter((c) => String(c.kizu).trim() !== "0");
  const preference = options.conditionPreference || "prefer-normal";

  // A condition on the input line wins over the global setting; otherwise an
  // "-only" setting names the condition.  Either way nothing is added
  // automatically from the other condition, but it is shown at zero so the
  // user can take it instead in review.
  const strict =
    request.condition ??
    (preference === "normal-only" ? "normal" : preference === "damaged-only" ? "damaged" : null);
  if (strict) {
    const [wanted, other] = strict === "normal" ? [normal, damaged] : [damaged, normal];
    if (wanted.length > 1) return [makeAmbiguousRow(request, wanted)];
    const primary = wanted.length
      ? makeSingleRow(request, wanted[0], request.requestedQuantity)
      : { ...makeMissingRow(request, ERROR_CODES.PRODUCT_CONDITION_MISSING), condition: strict };
    if (other.length !== 1) return [primary];
    const otherRow = buildRow(request, other[0], 0, numbersForProduct(other[0]).stock);
    return [primary, asOption(otherRow, ERROR_CODES.PRODUCT_OTHER_CONDITION)];
  }

  // No condition given: prefer-normal or prefer-damaged fills from that
  // condition first and takes the rest from the other when stock is short.
  if (normal.length > 1 || damaged.length > 1) {
    return [makeAmbiguousRow(request, exact)];
  }

  if (normal.length === 1 && damaged.length === 0) {
    return [makeSingleRow(request, normal[0], request.requestedQuantity)];
  }

  if (damaged.length === 1 && normal.length === 0) {
    return [makeSingleRow(request, damaged[0], request.requestedQuantity)];
  }

  if (normal.length === 1 && damaged.length === 1) {
    const [first, second] =
      preference === "prefer-damaged" ? [damaged[0], normal[0]] : [normal[0], damaged[0]];
    const firstStock = numbersForProduct(first).stock;
    const secondStock = numbersForProduct(second).stock;
    const firstPlanned = Math.min(request.requestedQuantity, firstStock);
    const secondPlanned = Math.min(request.requestedQuantity - firstPlanned, secondStock);
    const short = firstPlanned + secondPlanned < request.requestedQuantity;
    const status = (stock) => (stock <= 0 ? "sold-out" : short ? "partial" : "ready");
    const firstRow = buildRow(request, first, firstPlanned, firstStock, status(firstStock));
    const secondRow = buildRow(request, second, secondPlanned, secondStock, status(secondStock));
    // A fallback the preferred condition fully covered adds nothing; show it
    // like any other zero-quantity option.
    return [firstRow, secondPlanned > 0 ? secondRow : asOption(secondRow, ERROR_CODES.PRODUCT_OTHER_CONDITION)];
  }

  return [makeMissingRow(request)];
}

function notifyProgress(options, progress) {
  if (typeof options.onProgress !== "function") return;
  try {
    options.onProgress(progress);
  } catch {
    // A UI callback must never interrupt a lookup.
  }
}

async function delayBetweenQueries(options, queryNumber) {
  const delay = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 250;
  if (queryNumber > 0) await sleep(delay, options);
}

function queryExpectedIds(values) {
  return new Set(values.map((value) => normalizePrintedId(requestId(value))).filter(Boolean));
}

function assertStructure(parsed, query, expectedIds) {
  if (!parsed?.structureError) return;
  const matching = matchingProducts(parsed.products, expectedIds);
  // A query can legitimately return cards outside the requested set (for
  // example a broad prefix that was truncated).  Only treat a page as a site
  // break when it has no usable expected candidate or contains malformed card
  // elements throughout.
  const allCandidatesInvalid =
    parsed.cardProductCount > 0 &&
    parsed.products.length === 0;
  const noCardMarkup = parsed.cardProductCount === 0 && !parsed.explicitEmpty;
  if (allCandidatesInvalid || (noCardMarkup && matching.size === 0)) {
    throw new LookupError(
      LOOKUP_ERROR_CODES.SITE_CHANGED,
      `YYT search structure could not be parsed for ${query}`,
      {
        query,
        rejected: parsed.rejected ?? [],
      },
    );
  }
}

/**
 * Resolve input IDs using one grouped prefix GET per prefix, then exact GET
 * fallbacks for IDs not returned by their prefix response.
 *
 * A search that fails (HTTP, network, or an unreadable page) marks only the
 * IDs it was for as `error` rows; the rest of the lookup carries on.  IDs whose
 * prefix search failed are not retried one by one, so a broken site is not
 * hit with a request per card.  Cancellation still rejects the whole lookup.
 */
export async function lookupProducts(requests, options = {}) {
  const normalizedRequests = normalizeRequests(requests);
  const validRequests = normalizedRequests.filter((request) => !request.invalid);
  const expectedIds = new Set(validRequests.map((request) => request.normalizedId));
  const candidatesById = new Map();
  const failuresById = new Map();
  const queries = [];
  const { groups, fallbackIds } = buildLookupPlan(validRequests);

  let queryNumber = 0;
  const runQuery = async (type, query, queryIds, progress) => {
    await delayBetweenQueries(options, queryNumber);
    queryNumber += 1;
    notifyProgress(options, { type, query, ...progress });
    try {
      const page = await fetchSearchPage(query, options);
      const parsed = parseSearchResults(page.html);
      assertStructure(parsed, query, queryIds);
      mergeCandidates(candidatesById, matchingProducts(parsed.products, expectedIds));
      queries.push({
        type,
        query,
        url: page.url,
        status: page.status,
        cardProductCount: parsed.cardProductCount,
        productCount: parsed.products.length,
      });
    } catch (error) {
      if (options.signal?.aborted || !(error instanceof LookupError)) throw error;
      for (const id of queryIds) failuresById.set(id, error);
      queries.push({ type, query, url: error.url ?? null, status: error.status ?? null, error: error.code });
    }
  };

  let groupIndex = 0;
  for (const [prefix, values] of groups) {
    await runQuery("prefix", prefix, queryExpectedIds(values), { index: groupIndex, total: groups.size });
    groupIndex += 1;
  }

  for (const request of validRequests) {
    if (!candidatesById.has(request.normalizedId) && !failuresById.has(request.normalizedId)) {
      fallbackIds.push(request);
    }
  }

  // An ID can be absent from both prefix groups and the first fallback pass;
  // dedupe by normalized ID while preserving first-seen spelling.
  const exactFallbacks = [];
  const fallbackSeen = new Set();
  for (const request of fallbackIds) {
    if (fallbackSeen.has(request.normalizedId)) continue;
    fallbackSeen.add(request.normalizedId);
    exactFallbacks.push(request);
  }

  for (const [fallbackIndex, request] of exactFallbacks.entries()) {
    await runQuery("exact", request.originalId, new Set([request.normalizedId]), {
      index: fallbackIndex,
      total: exactFallbacks.length,
    });
  }

  const rows = dropDuplicateOptions(
    normalizedRequests.flatMap((request) => {
      // Another search can still return this ID's product; only an ID with
      // no candidates at all is reported as failed.
      const failure = request.invalid || candidatesById.has(request.normalizedId)
        ? null
        : failuresById.get(request.normalizedId);
      return failure
        ? [makeErrorRow(request, failure)]
        : makeRows(request, candidatesById.get(request.normalizedId), options);
    }),
  );
  return {
    rows,
    requests: normalizedRequests,
    queries,
    candidatesById,
  };
}
