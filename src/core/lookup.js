import {
  normalizePrintedId,
  parseSearchResults,
} from "./parser.js";
import { ERROR_CODES, YytError } from "./errors.js";

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
  const originals = Array.isArray(value.originalIds) ? value.originalIds : [];
  return String(
    value.originalId ??
      value.printedId ??
      value.id ??
      originals[0] ??
      value.normalizedId ??
      "",
  ).trim();
}

function requestQuantity(value) {
  if (typeof value === "string" || !value || typeof value !== "object") return 1;
  return value.requestedQuantity ?? value.quantity ?? value.count ?? 1;
}

function sourceLines(value) {
  if (!value || typeof value !== "object") return [];
  const lines = value.sourceLines ?? value.lineNumbers ?? [];
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

  return {
    originalId: printedId || originals[0] || String(value?.normalizedId ?? ""),
    originalIds: originals,
    normalizedId,
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
    const existing = byId.get(request.normalizedId);
    byId.set(request.normalizedId, mergeRequest(existing, request));
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
  const fallbackIds = values.filter((value) => !groupedValues.has(value));
  return {
    groups,
    prefixGroups: groups,
    prefixQueries: [...groups.keys()],
    fallbackIds,
    exactIds: fallbackIds,
  };
}

export const groupLookupIds = groupIdsByPrefix;
export const planLookupQueries = buildLookupPlan;

/**
 * Compatibility-shaped grouping helper for callers that already use the
 * input parser's `{ groups, exactFallback }` representation.  The lookup
 * layer itself uses the Map-returning helper above so it can accept raw IDs as
 * well as parsed request objects.
 */
export function groupRequestsByPrefix(values) {
  const groups = groupIdsByPrefix(values);
  const groupedValues = new Set([...groups.values()].flat());
  return {
    groups: [...groups.entries()].map(([prefix, requests]) => ({
      prefix,
      normalizedPrefix: normalizePrintedId(prefix),
      query: prefix,
      requests,
    })),
    exactFallback: values.filter((value) => !groupedValues.has(value)),
  };
}

function getFetch(options) {
  const fetchFunction = options.fetch ?? options.fetchFn ?? options.fetchImpl;
  if (typeof fetchFunction === "function") return fetchFunction;
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
  if (options.baseUrl) return String(options.baseUrl);
  if (typeof globalThis !== "undefined" && globalThis.location?.origin) {
    return globalThis.location.origin;
  }
  return "https://yuyu-tei.jp";
}

function makeSearchUrl(query, options) {
  if (typeof options.buildSearchUrl === "function") {
    return options.buildSearchUrl(query);
  }
  const url = new URL(options.searchPath ?? "/sell/ws/s/search", getOrigin(options));
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

async function sleep(milliseconds, options) {
  if (milliseconds <= 0) return;
  if (typeof options.sleep === "function") {
    await options.sleep(milliseconds);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    try {
      response = await fetchFunction(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "text/html" },
        ...(options.signal ? { signal: options.signal } : {}),
      });
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

    let html;
    try {
      html = await response.text();
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(retryBaseMs * 2 ** attempt, options);
        attempt += 1;
        continue;
      }
      throw new LookupError(LOOKUP_ERROR_CODES.NETWORK, "YYT search response could not be read", {
        cause: error,
        query: String(query),
        url,
      });
    }

    return { query: String(query), url, status, html, response };
  }
}

function parserReport(html, options) {
  const parser = options.parseSearchResults ?? options.parser;
  const parsed = typeof parser === "function" ? parser(html, options) : parseSearchResults(html, options);
  if (Array.isArray(parsed)) {
    return {
      products: parsed,
      candidates: parsed,
      rejected: [],
      cardProductCount: parsed.length,
      structureError: false,
      explicitEmpty: parsed.length === 0,
    };
  }
  return parsed;
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
    reason: "INPUT_INVALID",
    canonicalPrintedId: null,
    product: null,
    name: "",
    priceYen: null,
    availableStock: 0,
    plannedQuantity: 0,
    selected: false,
  };
}

function makeRow(request, candidates) {
  if (request.invalid) return makeInvalidRow(request);

  const exact = candidates ?? [];
  if (exact.length === 0) {
    return {
      ...request,
      status: "missing",
      reason: "PRODUCT_MISSING",
      canonicalPrintedId: null,
      product: null,
      name: "",
      priceYen: null,
      availableStock: 0,
      plannedQuantity: 0,
      selected: false,
      candidates: [],
    };
  }

  if (exact.length > 1) {
    return {
      ...request,
      status: "ambiguous",
      reason: "PRODUCT_AMBIGUOUS",
      canonicalPrintedId: null,
      product: null,
      name: "",
      priceYen: null,
      availableStock: 0,
      plannedQuantity: 0,
      selected: false,
      candidates: exact,
    };
  }

  const product = exact[0];
  const numbers = numbersForProduct(product);
  const soldOut = Boolean(product.soldOut) || numbers.stock <= 0;
  const plannedQuantity = soldOut ? 0 : Math.min(request.requestedQuantity, numbers.stock);
  const status =
    soldOut ? "sold-out" : plannedQuantity < request.requestedQuantity ? "partial" : "ready";

  return {
    ...request,
    status,
    reason:
      status === "ready"
        ? null
        : status === "partial"
          ? "PRODUCT_PARTIAL_STOCK"
          : "PRODUCT_SOLD_OUT",
    canonicalPrintedId: product.printedId,
    product,
    name: product.name ?? "",
    priceYen: product.priceYen ?? null,
    availableStock: numbers.stock,
    plannedQuantity,
    selected: status === "ready" || status === "partial",
    candidates: exact,
  };
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
    parsed.products.length === 0 &&
    (parsed.rejected ?? []).some((error) => error?.code !== "PRODUCT_DAMAGED");
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
 */
export async function lookupProducts(requests, options = {}) {
  const normalizedRequests = normalizeRequests(requests);
  const validRequests = normalizedRequests.filter((request) => !request.invalid);
  const expectedIds = new Set(validRequests.map((request) => request.normalizedId));
  const candidatesById = new Map();
  const queries = [];
  const fallbackIds = [];
  const groups = groupIdsByPrefix(validRequests);
  const grouped = new Set([...groups.values()].flat());
  for (const request of validRequests) {
    if (!grouped.has(request)) fallbackIds.push(request);
  }

  let queryNumber = 0;
  for (const [prefix, values] of groups) {
    await delayBetweenQueries(options, queryNumber);
    queryNumber += 1;
    const page = await fetchSearchPage(prefix, options);
    const parsed = parserReport(page.html, { ...options, expectedIds: queryExpectedIds(values) });
    assertStructure(parsed, prefix, queryExpectedIds(values));
    const matches = matchingProducts(parsed.products, expectedIds);
    mergeCandidates(candidatesById, matches);
    queries.push({
      type: "prefix",
      query: prefix,
      url: page.url,
      status: page.status,
      cardProductCount: parsed.cardProductCount,
      productCount: parsed.products.length,
    });
  }

  for (const request of validRequests) {
    if (!candidatesById.has(request.normalizedId)) fallbackIds.push(request);
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

  for (const request of exactFallbacks) {
    await delayBetweenQueries(options, queryNumber);
    queryNumber += 1;
    const page = await fetchSearchPage(request.originalId, options);
    const parsed = parserReport(page.html, { ...options, expectedIds: new Set([request.normalizedId]) });
    assertStructure(parsed, request.originalId, new Set([request.normalizedId]));
    const matches = matchingProducts(parsed.products, expectedIds);
    mergeCandidates(candidatesById, matches);
    queries.push({
      type: "exact",
      query: request.originalId,
      url: page.url,
      status: page.status,
      cardProductCount: parsed.cardProductCount,
      productCount: parsed.products.length,
    });
  }

  const rows = normalizedRequests.map((request) => makeRow(request, candidatesById.get(request.normalizedId)));
  return {
    rows,
    items: rows,
    results: rows,
    requests: normalizedRequests,
    queries,
    candidatesById,
  };
}

export const lookupCards = lookupProducts;
export const resolveCards = lookupProducts;
export const lookupPrintedIds = lookupProducts;
export const searchCards = lookupProducts;
export const resolveLookup = lookupProducts;
