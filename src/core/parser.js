/**
 * Defensive parsing helpers for the HTML returned by YYT's Weiss Schwarz
 * sales search.  Pages are read with DOMParser, which never runs their
 * scripts; Node tests supply happy-dom's.
 */

import { ERROR_CODES } from "./errors.js";

export const PRINTED_ID_PATTERN =
  /[A-Za-z0-9][A-Za-z0-9._]*\/[A-Za-z0-9][A-Za-z0-9._-]*-(?:\d{1,4}|[A-Za-z]{1,6}\d{0,4})(?:[A-Za-z0-9+._']*)/g;

const EMPTY_RESULT_PATTERNS = [
  /no\s+results?/i,
  /not\s+found/i,
  /no\s+products?/i,
  /(?:product|card)s?[^.]{0,40}(?:unavailable|none|does not exist)/i,
  /該当する商品(?:が|は)?(?:ありません|見つかりません)/i,
  /(?:商品|カード)[^。]{0,30}(?:ありません|見つかりません|該当しません|該当なし)/i,
  /商品が見つかりません/i,
  /検索結果(?:は)?[^\d]{0,10}0\s*件/i,
  /(?:検索|search)[^\d]{0,20}0\s*(?:件|results?)/i,
];

/**
 * Normalize a printed card ID without removing punctuation or rarity
 * suffixes.  The locale is explicit because this value is an identifier, not
 * user-facing prose.
 */
export function normalizePrintedId(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US");
}

/**
 * Return the first conservative Weiss ID-looking token in a string.
 */
export function extractPrintedId(value) {
  if (value == null) return null;

  const text = String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .trim();
  if (!text) return null;

  // RegExp instances with the global flag retain lastIndex.  Resetting it
  // makes this helper safe to call repeatedly on the same exported pattern.
  PRINTED_ID_PATTERN.lastIndex = 0;
  const match = PRINTED_ID_PATTERN.exec(text);
  if (!match) return null;

  // Markup/text often puts punctuation immediately after an ID.  Punctuation
  // that belongs to a rarity suffix (for example + or ') is retained.
  return match[0].replace(/[.,;:!?\])}]+$/u, "") || null;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasClass(element, className) {
  return element?.classList?.contains(className) ?? false;
}

function getAttribute(element, name) {
  return element?.getAttribute(name) ?? null;
}

function nodeText(element) {
  if (!element) return "";
  return cleanText(element.textContent ?? "");
}

function queryOne(element, selector) {
  return element?.querySelector?.(selector) ?? null;
}

function queryAll(element, selector) {
  const result = element?.querySelectorAll?.(selector);
  if (!result) return [];
  return Array.from(result);
}

function readField(element, selector) {
  const field = queryOne(element, selector);
  if (!field) return null;
  // YYT uses hidden inputs, while small fixtures and future site revisions may
  // use a data/value-bearing element.  Keep "0"; truthiness is incorrect for
  // the normal-condition and sold-out flags.
  const value = getAttribute(field, "value");
  if (value != null && value.trim() !== "") return value.trim();
  const dataValue = getAttribute(field, "data-value");
  if (dataValue != null && dataValue.trim() !== "") return dataValue.trim();
  const text = nodeText(field);
  return text || null;
}

export function parseNonNegativeInteger(value) {
  if (value == null) return null;
  const compact = String(value)
    .replace(/[\u00a0\u2007\u202f\s,]/g, "")
    .trim();
  if (!/^\d+$/u.test(compact)) return null;
  const parsed = Number.parseInt(compact, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parsePriceYen(value) {
  if (value == null) return null;
  const text = cleanText(value);
  // A decimal price is not a valid integer yen amount.  Keep comma-separated
  // thousands (`12,800`) valid while rejecting decimal comma notation such as
  // `12,80`.
  if (/\d\s*\.\s*\d/u.test(text) || /\d\s*,\s*\d{1,2}(?:\D|$)/u.test(text)) {
    return null;
  }
  // Price markup may include a currency symbol, tax note, or trailing prose.
  // Pick a contiguous integer token rather than accidentally using an ID or
  // quantity elsewhere in the card.
  const match = text.match(/(?:¥|￥)?\s*\d[\d,\s]*(?:円)?/u);
  if (!match) return null;
  const compact = match[0].replace(/[¥￥円,\s]/gu, "");
  if (!/^\d+$/u.test(compact)) return null;
  const parsed = Number.parseInt(compact, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readPrintedId(element) {
  // The bordered span is the most authoritative visible identity on current
  // YYT pages.  Do not use arbitrary card-product text: it can contain names,
  // set headings, and unrelated numbers.
  for (const span of queryAll(element, "span")) {
    const printedId = extractPrintedId(nodeText(span));
    if (printedId) return printedId;
  }

  // The card image alt is the documented fallback and is useful when a small
  // site variant omits the visible ID span.
  for (const image of queryAll(element, "img.card")) {
    const printedId = extractPrintedId(getAttribute(image, "alt"));
    if (printedId) return printedId;
  }
  return null;
}

// Rarity labels as YYT prints them: `RR`, `S-RR`, `SP`, `SEC+`, `PR`,
// `SR★★`, `M@P`, and `-` for cards with no rarity.
const RARITY_PATTERN = /^(?:(?:[A-Z]{1,2}-)?[A-Z@]{1,5}(?:\+|★{1,3})?|-)$/u;

/**
 * Return a rarity in YYT's spelling, or null for anything else.  `*` and `☆`
 * stand in for `★`, which most keyboards cannot type: `SR**` is `SR★★`.
 */
export function normalizeRarity(value) {
  if (value == null) return null;
  const text = String(value).normalize("NFKC").trim().toLocaleUpperCase("en-US").replace(/[*☆]/gu, "★");
  return RARITY_PATTERN.test(text) ? text : null;
}

/**
 * Some sets list two products under one printed ID (for example RZ/SE35-01 as
 * both RR and the S-RR holo parallel).  The only distinguishing labels are
 * the rarity token after the ID in the image alt and the list heading the card
 * sits under.  The rarity never establishes identity on its own; it only
 * separates products that already share an exact printed ID.
 */
function readRarity(element, printedId, sectionRarity) {
  for (const image of queryAll(element, "img.card")) {
    const alt = cleanText(getAttribute(image, "alt"));
    const index = alt.indexOf(printedId);
    if (index < 0) continue;
    const token = alt.slice(index + printedId.length).trim().split(" ")[0];
    const rarity = normalizeRarity(token);
    if (rarity) return rarity;
  }
  return sectionRarity ?? null;
}

function readSectionRarity(heading) {
  const match = /^(\S+)\s+Card List$/iu.exec(nodeText(heading));
  return match ? normalizeRarity(match[1]) : null;
}

function readDetailUrl(element) {
  const link = queryOne(element, 'a[href*="/sell/ws/card/"]');
  return getAttribute(link, "href")?.trim() || null;
}

function readPrice(element) {
  let fallbackPrice = null;
  for (const strong of queryAll(element, "strong")) {
    const text = nodeText(strong);
    if (!text) continue;
    const priceYen = parsePriceYen(text);
    if (priceYen == null) continue;
    // A card may contain another bold numeric badge (for example, a stock
    // count). Currency-marked text is preferred over an unmarked fallback.
    if (/[¥￥円]/u.test(text)) return priceYen;
    fallbackPrice ??= priceYen;
  }
  return fallbackPrice;
}

function containsSoldOut(element) {
  return hasClass(element, "sold-out") || queryAll(element, ".sold-out").length > 0;
}

function requiredFieldError(field) {
  return {
    code: ERROR_CODES.PRODUCT_INVALID,
    reason: `missing or invalid ${field}`,
    field,
  };
}

/**
 * Parse one `.card-product` element, recording why a candidate was rejected
 * so lookup can tell a normal empty result from a wholesale selector break.
 */
function parseProductElement(element, sectionRarity = null) {
  if (!element) return { product: null, error: requiredFieldError("card-product") };

  const gid = readField(element, ".cart_gid");
  const ver = readField(element, ".cart_ver");
  const cid = readField(element, ".cart_cid");
  const kizu = readField(element, ".cart_kizu");
  for (const [field, value] of [
    ["cart_gid", gid],
    ["cart_ver", ver],
    ["cart_cid", cid],
    ["cart_kizu", kizu],
  ]) {
    if (value == null || value === "") {
      return { product: null, error: requiredFieldError(field) };
    }
  }

  const printedId = readPrintedId(element);
  if (!printedId) {
    return { product: null, error: requiredFieldError("printed ID") };
  }

  const activeRaw = readField(element, ".cart_active");
  const limitRaw = readField(element, ".cart_limit");
  const active = parseNonNegativeInteger(activeRaw);
  const limit = parseNonNegativeInteger(limitRaw);
  if (active == null) {
    return { product: null, error: requiredFieldError("cart_active") };
  }
  if (limit == null) {
    return { product: null, error: requiredFieldError("cart_limit") };
  }

  const priceYen = readPrice(element);
  if (priceYen == null) {
    return { product: null, error: requiredFieldError("price") };
  }

  const detailUrl = readDetailUrl(element);
  if (!detailUrl) {
    return { product: null, error: requiredFieldError("detail URL") };
  }

  const kizuStr = String(kizu).trim();
  if (!/^\d+$/u.test(kizuStr)) {
    return { product: null, error: requiredFieldError("cart_kizu") };
  }
  const condition = kizuStr === "0" ? "normal" : "damaged";

  const soldOut = containsSoldOut(element) || active === 0 || limit === 0;
  const stock = Math.min(active, limit);

  const product = {
    printedId,
    normalizedId: normalizePrintedId(printedId),
    rarity: readRarity(element, printedId, sectionRarity),
    name: nodeText(queryOne(element, "h4")),
    gid: String(gid),
    ver: String(ver),
    cid: String(cid),
    kizu: kizuStr,
    condition,
    stock,
    limit,
    priceYen,
    detailUrl,
    cartActive: active,
    cartLimit: limit,
    soldOut,
    available: !soldOut,
  };

  return { product, error: null };
}

function looksLikeExplicitEmptyResult(html) {
  const text = cleanText(String(html ?? ""));
  return EMPTY_RESULT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Return card elements in document order, each paired with the rarity of the
 * `… Card List` heading above it; comma-selector matches come back in
 * document order.
 */
function collectCardProducts(document) {
  const cards = [];
  let sectionRarity = null;
  for (const element of queryAll(document, "h3, .card-product")) {
    if (hasClass(element, "card-product")) cards.push({ element, sectionRarity });
    else sectionRarity = readSectionRarity(element);
  }
  return cards;
}

/**
 * A search shows at most 600 cards per page and links the rest as
 * `?search_word=…&page=N`.  Return the highest page linked, or 1.
 */
function readLastPage(document) {
  let last = 1;
  for (const link of queryAll(document, 'a[href*="page="]')) {
    const match = /[?&]page=(\d+)/u.exec(getAttribute(link, "href") ?? "");
    if (match) last = Math.max(last, Number(match[1]));
  }
  return last;
}

/**
 * Parse a search response and preserve diagnostics needed by lookup.
 *
 * `structureError` is true when cards are present but all candidates are
 * unusable, or when a non-empty response has neither the expected cards nor an
 * explicit no-results marker.  Callers should avoid presenting such a page as
 * a routine collection of missing cards.
 */
export function parseSearchResults(html) {
  const source = String(html ?? "");
  const document = new DOMParser().parseFromString(source, "text/html");
  const cardElements = collectCardProducts(document);
  const products = [];
  const rejected = [];

  for (const { element, sectionRarity } of cardElements) {
    const parsed = parseProductElement(element, sectionRarity);
    if (parsed.product) products.push(parsed.product);
    else rejected.push(parsed.error);
  }

  const explicitEmpty = looksLikeExplicitEmptyResult(source);
  const lastPage = readLastPage(document);
  const structureError =
    (cardElements.length > 0 && products.length === 0) ||
    (cardElements.length === 0 && source.trim() !== "" && !explicitEmpty);

  return {
    products,
    rejected,
    cardProductCount: cardElements.length,
    structureError,
    explicitEmpty,
    lastPage,
  };
}

