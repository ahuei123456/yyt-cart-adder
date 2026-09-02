/**
 * Defensive parsing helpers for the HTML returned by YYT's Weiss Schwarz
 * sales search.
 *
 * The browser uses DOMParser.  A small inert HTML tree implementation is
 * included for Node tests so the core can be exercised without bringing a DOM
 * dependency into the userscript bundle.  The fallback is intentionally only
 * an HTML reader; it never evaluates script elements.
 */

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

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

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

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, "\u00a0")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match;
    })
    .replace(/&#(\d+);/g, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match;
    });
}

function cleanText(value) {
  return decodeHtmlEntities(String(value ?? ""))
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classNames(element) {
  const value =
    element?.getAttribute?.("class") ??
    (typeof element?.className === "string" ? element.className : "");
  return String(value)
    .split(/\s+/u)
    .map((name) => name.trim())
    .filter(Boolean);
}

function hasClass(element, className) {
  if (!element) return false;
  if (element.classList?.contains?.(className)) return true;
  return classNames(element).includes(className);
}

function getAttribute(element, name) {
  if (!element) return null;
  const value = element.getAttribute?.(name);
  if (value != null) return String(value);
  const property = element[name];
  return property == null ? null : String(property);
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
    code: "PRODUCT_INVALID",
    reason: `missing or invalid ${field}`,
    field,
  };
}

/**
 * Parse one `.card-product` element.
 *
 * The public helper returns a product or null.  The internal detailed helper
 * additionally records why a candidate was rejected, which lets lookup
 * distinguish a normal empty result from a wholesale selector break.
 */
function parseProductElementDetailed(element) {
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

export function parseProductElement(element) {
  return parseProductElementDetailed(element).product;
}

// Aliases make the parser easy to consume from a small userscript and from
// tests written around either the noun used by the handoff or the CSS class.
export const parseCardProduct = parseProductElement;

function looksLikeExplicitEmptyResult(html) {
  const text = cleanText(String(html ?? ""));
  return EMPTY_RESULT_PATTERNS.some((pattern) => pattern.test(text));
}

function getBrowserDocument(html, options) {
  if (options?.document?.querySelectorAll) return options.document;

  const parserConstructor =
    options?.DOMParser ??
    (typeof globalThis !== "undefined" ? globalThis.DOMParser : undefined);
  if (typeof parserConstructor !== "function") return null;

  const parser = new parserConstructor();
  return parser.parseFromString(String(html ?? ""), "text/html");
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const attributePattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  let match;
  while ((match = attributePattern.exec(source))) {
    const name = match[1].toLocaleLowerCase("en-US");
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function matchesAttributeSelector(element, selector) {
  const match = selector.match(/^\[([\w:-]+)(?:\s*([*^$|~]?=)\s*["']?([^\]"']*)["']?)?\]$/u);
  if (!match) return false;
  const attribute = getAttribute(element, match[1]);
  if (attribute == null) return false;
  if (!match[2]) return true;
  const expected = match[3] ?? "";
  switch (match[2]) {
    case "*=":
      return attribute.includes(expected);
    case "^=":
      return attribute.startsWith(expected);
    case "$=":
      return attribute.endsWith(expected);
    case "~=":
      return attribute.split(/\s+/u).includes(expected);
    case "|=":
      return attribute === expected || attribute.startsWith(`${expected}-`);
    case "=":
      return attribute === expected;
    default:
      return false;
  }
}

function matchesSimpleSelector(element, selector) {
  if (!element || !selector) return false;
  const trimmed = selector.trim();
  if (!trimmed) return false;

  const attributes = [...trimmed.matchAll(/\[[^\]]+\]/gu)];
  for (const attribute of attributes) {
    if (!matchesAttributeSelector(element, attribute[0])) return false;
  }
  const withoutAttributes = trimmed.replace(/\[[^\]]+\]/gu, "");
  const tagMatch = withoutAttributes.match(/^([A-Za-z][\w:-]*)/u);
  if (tagMatch && String(element.tagName ?? element.tag ?? "").toLocaleLowerCase("en-US") !== tagMatch[1].toLocaleLowerCase("en-US")) {
    return false;
  }
  for (const classMatch of withoutAttributes.matchAll(/\.([\w-]+)/gu)) {
    if (!hasClass(element, classMatch[1])) return false;
  }
  return true;
}

class HtmlNode {
  constructor(tag, attributes = Object.create(null), parent = null) {
    this.tag = tag;
    this.tagName = tag === "#root" ? "" : tag.toUpperCase();
    this.attributes = attributes;
    this.parent = parent;
    this.children = [];
    this.text = "";
  }

  getAttribute(name) {
    const value = this.attributes[String(name).toLocaleLowerCase("en-US")];
    return value == null ? null : value;
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  querySelectorAll(selector) {
    const selectors = String(selector)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.tag !== "#text" && selectors.some((item) => matchesSimpleSelector(child, item))) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function parseFallbackHtml(html) {
  const root = new HtmlNode("#root");
  const stack = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>/gu;
  let cursor = 0;
  let token;

  const appendText = (value) => {
    if (!value) return;
    const node = new HtmlNode("#text", Object.create(null), stack[stack.length - 1]);
    node.text = decodeHtmlEntities(value);
    stack[stack.length - 1].children.push(node);
  };

  while ((token = tokenPattern.exec(String(html ?? "")))) {
    appendText(String(html ?? "").slice(cursor, token.index));
    cursor = tokenPattern.lastIndex;
    const source = token[0];
    if (/^<!--|^<!/u.test(source)) continue;

    const closing = /^<\//u.test(source);
    const content = source.replace(/^<\/?|>$/gu, "").trim();
    const nameMatch = content.match(/^([^\s/>]+)/u);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLocaleLowerCase("en-US");

    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const attributesSource = content.slice(nameMatch[0].length);
    const node = new HtmlNode(name, parseAttributes(attributesSource), stack[stack.length - 1]);
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(name) && !/\/\s*$/u.test(content)) stack.push(node);
  }
  appendText(String(html ?? "").slice(cursor));
  return root;
}

function collectCardProducts(document) {
  return queryAll(document, ".card-product");
}

/**
 * Parse a search response and preserve diagnostics needed by lookup.
 *
 * `structureError` is true when cards are present but all candidates are
 * unusable, or when a non-empty response has neither the expected cards nor an
 * explicit no-results marker.  Callers should avoid presenting such a page as
 * a routine collection of missing cards.
 */
export function parseSearchResults(html, options = {}) {
  const source = String(html ?? "");
  const document = getBrowserDocument(source, options) ?? parseFallbackHtml(source);
  const cardElements = collectCardProducts(document);
  const products = [];
  const rejected = [];

  for (const element of cardElements) {
    const parsed = parseProductElementDetailed(element);
    if (parsed.product) products.push(parsed.product);
    else rejected.push(parsed.error);
  }

  const explicitEmpty = looksLikeExplicitEmptyResult(source);
  const onlyDamagedCandidates =
    cardElements.length > 0 &&
    rejected.length > 0 &&
    rejected.every((error) => error?.code === "PRODUCT_DAMAGED");
  const structureError =
    (cardElements.length > 0 && products.length === 0 && !onlyDamagedCandidates) ||
    (cardElements.length === 0 && source.trim() !== "" && !explicitEmpty);

  return {
    products,
    candidates: products,
    rejected,
    cardProductCount: cardElements.length,
    structureError,
    explicitEmpty,
    document,
  };
}

/**
 * Convenient array-returning API for callers that only need valid products.
 * Diagnostics remain available through parseSearchResults.
 */
export function parseSearchHtml(html, options = {}) {
  return parseSearchResults(html, options).products;
}

export const parseProductsFromHtml = parseSearchHtml;
export const parseCardProducts = parseSearchHtml;
export const parseSearchDocument = parseSearchHtml;
