// ==UserScript==
// @name         YYT Weiss Schwarz Cart Adder
// @namespace    local.yyt-cart-adder
// @version      0.1.0
// @description  Resolve Weiss Schwarz card IDs and add reviewed quantities to a YYT cart.
// @match        https://yuyu-tei.jp/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(() => {
  // src/core/errors.js
  var ERROR_CODES = Object.freeze({
    INPUT_INVALID: "INPUT_INVALID",
    LOOKUP_NETWORK: "LOOKUP_NETWORK",
    LOOKUP_HTTP: "LOOKUP_HTTP",
    LOOKUP_SITE_CHANGED: "LOOKUP_SITE_CHANGED",
    PRODUCT_MISSING: "PRODUCT_MISSING",
    PRODUCT_AMBIGUOUS: "PRODUCT_AMBIGUOUS",
    PRODUCT_SOLD_OUT: "PRODUCT_SOLD_OUT",
    PRODUCT_PARTIAL_STOCK: "PRODUCT_PARTIAL_STOCK",
    CSRF_MISSING: "CSRF_MISSING",
    CART_REJECTED: "CART_REJECTED",
    CART_AUTH: "CART_AUTH",
    CART_RATE_LIMIT: "CART_RATE_LIMIT",
    CART_SERVER: "CART_SERVER",
    CART_RESPONSE_INVALID: "CART_RESPONSE_INVALID",
    CART_OUTCOME_UNKNOWN: "CART_OUTCOME_UNKNOWN",
    CANCELLED: "CANCELLED"
  });
  var YytError = class extends Error {
    constructor(code, message, details = void 0) {
      super(message);
      this.name = "YytError";
      this.code = code;
      if (details !== void 0) {
        this.details = details;
      }
    }
  };
  function createYytError(code, message, details = void 0) {
    return new YytError(code, message, details);
  }

  // src/core/input.js
  var INTEGER_PATTERN = /^\d+$/u;
  var CARD_TOKEN_PATTERN = /^\S+$/u;
  function normalizePrintedId(value) {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().toLocaleLowerCase("en-US");
  }
  function makeInputError({ lineNumber, raw, message, lineNumbers = [lineNumber], normalizedId, original }) {
    const error = createYytError(ERROR_CODES.INPUT_INVALID, message, {
      lineNumber,
      lineNumbers,
      raw,
      ...normalizedId ? { normalizedId } : {}
    });
    return {
      code: error.code,
      message: error.message,
      reason: error.message,
      lineNumber,
      lineNumbers,
      raw,
      ...original ? { original } : {},
      ...normalizedId ? { normalizedId } : {}
    };
  }
  function parseConditionToken(token) {
    if (typeof token !== "string") return null;
    const lower = token.trim().toLowerCase();
    if (lower === "damaged" || lower === "damage" || lower === "kizu" || lower === "1") {
      return "damaged";
    }
    if (lower === "normal" || lower === "0") {
      return "normal";
    }
    return null;
  }
  var RARITY_TOKEN_PATTERN = /^(?:[A-Z]{1,2}-)?[A-Z]{1,4}\+?$/u;
  function parseRarityToken(token) {
    if (typeof token !== "string" || !RARITY_TOKEN_PATTERN.test(token)) return null;
    return token;
  }
  function parseLine(raw, lineNumber) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return { kind: "ignored" };
    }
    const idMatch = /^([^\s,]+)([\s,].*)?$/u.exec(trimmed);
    if (!idMatch) {
      return {
        kind: "error",
        error: makeInputError({
          lineNumber,
          raw,
          message: "Card ID is required and may not contain whitespace."
        })
      };
    }
    const originalId = idMatch[1];
    const normalizedId = normalizePrintedId(originalId);
    if (!normalizedId || !CARD_TOKEN_PATTERN.test(originalId)) {
      return {
        kind: "error",
        error: makeInputError({
          lineNumber,
          raw,
          message: "Card ID is required and may not contain whitespace."
        })
      };
    }
    const remainder = idMatch[2]?.trim() ?? "";
    if (!remainder) {
      return {
        kind: "request",
        request: { originalId, normalizedId, quantity: 1, lineNumber }
      };
    }
    if (remainder.includes(",,") || remainder.endsWith(",")) {
      return {
        kind: "error",
        error: makeInputError({
          lineNumber,
          raw,
          original: originalId,
          normalizedId,
          message: "Quantity must be a whole number from 1 through 99."
        })
      };
    }
    const tokens = remainder.split(/[\s,]+/u).filter(Boolean);
    const tokenError = (message) => ({
      kind: "error",
      error: makeInputError({ lineNumber, raw, original: originalId, normalizedId, message })
    });
    if (tokens.length > 3) {
      return tokenError("Unexpected extra tokens on line.");
    }
    let quantity = 1;
    let condition = null;
    let rarity = null;
    let rest = tokens;
    if (INTEGER_PATTERN.test(rest[0])) {
      const parsedQty = Number(rest[0]);
      if (!Number.isSafeInteger(parsedQty) || parsedQty < 1 || parsedQty > 99) {
        return tokenError("Quantity must be a whole number from 1 through 99.");
      }
      quantity = parsedQty;
      rest = rest.slice(1);
    }
    for (const token of rest) {
      const parsedCondition = parseConditionToken(token);
      if (parsedCondition && !condition) {
        condition = parsedCondition;
        continue;
      }
      const parsedRarity = parseRarityToken(token);
      if (parsedRarity && !rarity) {
        rarity = parsedRarity;
        continue;
      }
      return tokenError(
        token === tokens[0] ? "Quantity must be a whole number from 1 through 99." : "Expected a condition ('damaged'/1 or 'normal'/0) or a rarity such as RR or S-RR."
      );
    }
    const request = { originalId, normalizedId, quantity, lineNumber };
    if (condition) {
      request.condition = condition;
    }
    if (rarity) {
      request.rarity = rarity;
    }
    return {
      kind: "request",
      request
    };
  }
  function parseInput(input) {
    if (typeof input !== "string") {
      throw new TypeError("Input must be a string.");
    }
    const requestsById = /* @__PURE__ */ new Map();
    const errors = [];
    input.split(/\r?\n/u).forEach((raw, index) => {
      const lineNumber = index + 1;
      const parsed = parseLine(raw, lineNumber);
      if (parsed.kind === "ignored") {
        return;
      }
      if (parsed.kind === "error") {
        errors.push(parsed.error);
        return;
      }
      const { originalId, normalizedId, quantity, condition, rarity, lineNumber: sourceLine } = parsed.request;
      const key = `${normalizedId}:${condition ?? ""}:${rarity ?? ""}`;
      const existing = requestsById.get(key);
      if (existing) {
        existing.originalIds.push(originalId);
        existing.sourceLines.push(sourceLine);
        existing.requestedQuantity += quantity;
        return;
      }
      const item = {
        originalIds: [originalId],
        normalizedId,
        requestedQuantity: quantity,
        sourceLines: [sourceLine]
      };
      if (condition) {
        item.condition = condition;
      }
      if (rarity) {
        item.rarity = rarity;
      }
      requestsById.set(key, item);
    });
    for (const [key, request] of requestsById) {
      if (request.requestedQuantity <= 99) {
        continue;
      }
      errors.push(
        makeInputError({
          lineNumber: request.sourceLines[0],
          lineNumbers: [...request.sourceLines],
          raw: request.originalIds.join(", "),
          original: request.originalIds[0],
          normalizedId: request.normalizedId,
          message: `Combined quantity for ${request.originalIds[0]} exceeds the maximum of 99.`
        })
      );
      requestsById.delete(key);
    }
    errors.sort((left, right) => left.lineNumber - right.lineNumber);
    const result = {
      requests: [...requestsById.values()],
      errors
    };
    Object.defineProperty(result, "invalid", {
      enumerable: false,
      configurable: false,
      get: () => result.errors
    });
    return result;
  }

  // src/core/parser.js
  var PRINTED_ID_PATTERN = /[A-Za-z0-9][A-Za-z0-9._]*\/[A-Za-z0-9][A-Za-z0-9._-]*-(?:\d{1,4}|[A-Za-z]{1,6}\d{0,4})(?:[A-Za-z0-9+._']*)/g;
  var EMPTY_RESULT_PATTERNS = [
    /no\s+results?/i,
    /not\s+found/i,
    /no\s+products?/i,
    /(?:product|card)s?[^.]{0,40}(?:unavailable|none|does not exist)/i,
    /該当する商品(?:が|は)?(?:ありません|見つかりません)/i,
    /(?:商品|カード)[^。]{0,30}(?:ありません|見つかりません|該当しません|該当なし)/i,
    /商品が見つかりません/i,
    /検索結果(?:は)?[^\d]{0,10}0\s*件/i,
    /(?:検索|search)[^\d]{0,20}0\s*(?:件|results?)/i
  ];
  var VOID_TAGS = /* @__PURE__ */ new Set([
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
    "wbr"
  ]);
  function normalizePrintedId2(value) {
    return String(value ?? "").trim().toLocaleLowerCase("en-US");
  }
  function extractPrintedId(value) {
    if (value == null) return null;
    const text = String(value).replace(/&nbsp;/gi, " ").replace(/[\u00a0\u2007\u202f]/g, " ").trim();
    if (!text) return null;
    PRINTED_ID_PATTERN.lastIndex = 0;
    const match = PRINTED_ID_PATTERN.exec(text);
    if (!match) return null;
    return match[0].replace(/[.,;:!?\])}]+$/u, "") || null;
  }
  function decodeHtmlEntities(value) {
    return String(value ?? "").replace(/&nbsp;/gi, "\xA0").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : _match;
    }).replace(/&#(\d+);/g, (_match, digits) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : _match;
    });
  }
  function cleanText(value) {
    return decodeHtmlEntities(String(value ?? "")).replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/g, " ").trim();
  }
  function classNames(element) {
    const value = element?.getAttribute?.("class") ?? (typeof element?.className === "string" ? element.className : "");
    return String(value).split(/\s+/u).map((name) => name.trim()).filter(Boolean);
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
    const value = getAttribute(field, "value");
    if (value != null && value.trim() !== "") return value.trim();
    const dataValue = getAttribute(field, "data-value");
    if (dataValue != null && dataValue.trim() !== "") return dataValue.trim();
    const text = nodeText(field);
    return text || null;
  }
  function parseNonNegativeInteger(value) {
    if (value == null) return null;
    const compact = String(value).replace(/[\u00a0\u2007\u202f\s,]/g, "").trim();
    if (!/^\d+$/u.test(compact)) return null;
    const parsed = Number.parseInt(compact, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  function parsePriceYen(value) {
    if (value == null) return null;
    const text = cleanText(value);
    if (/\d\s*\.\s*\d/u.test(text) || /\d\s*,\s*\d{1,2}(?:\D|$)/u.test(text)) {
      return null;
    }
    const match = text.match(/(?:¥|￥)?\s*\d[\d,\s]*(?:円)?/u);
    if (!match) return null;
    const compact = match[0].replace(/[¥￥円,\s]/gu, "");
    if (!/^\d+$/u.test(compact)) return null;
    const parsed = Number.parseInt(compact, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  function readPrintedId(element) {
    for (const span of queryAll(element, "span")) {
      const printedId = extractPrintedId(nodeText(span));
      if (printedId) return printedId;
    }
    for (const image of queryAll(element, "img.card")) {
      const printedId = extractPrintedId(getAttribute(image, "alt"));
      if (printedId) return printedId;
    }
    return null;
  }
  var RARITY_PATTERN = /^(?:[A-Za-z]{1,2}-)?[A-Za-z]{1,4}\+?$/u;
  function normalizeRarity(value) {
    if (value == null) return null;
    const text = String(value).trim().toLocaleUpperCase("en-US");
    return RARITY_PATTERN.test(text) ? text : null;
  }
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
      if (/[¥￥円]/u.test(text)) return priceYen;
      fallbackPrice ?? (fallbackPrice = priceYen);
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
      field
    };
  }
  function parseProductElementDetailed(element, sectionRarity = null) {
    if (!element) return { product: null, error: requiredFieldError("card-product") };
    const gid = readField(element, ".cart_gid");
    const ver = readField(element, ".cart_ver");
    const cid = readField(element, ".cart_cid");
    const kizu = readField(element, ".cart_kizu");
    for (const [field, value] of [
      ["cart_gid", gid],
      ["cart_ver", ver],
      ["cart_cid", cid],
      ["cart_kizu", kizu]
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
      normalizedId: normalizePrintedId2(printedId),
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
      available: !soldOut
    };
    return { product, error: null };
  }
  function looksLikeExplicitEmptyResult(html) {
    const text = cleanText(String(html ?? ""));
    return EMPTY_RESULT_PATTERNS.some((pattern) => pattern.test(text));
  }
  function getBrowserDocument(html, options) {
    if (options?.document?.querySelectorAll) return options.document;
    const parserConstructor = options?.DOMParser ?? (typeof globalThis !== "undefined" ? globalThis.DOMParser : void 0);
    if (typeof parserConstructor !== "function") return null;
    const parser = new parserConstructor();
    return parser.parseFromString(String(html ?? ""), "text/html");
  }
  function parseAttributes(source) {
    const attributes = /* @__PURE__ */ Object.create(null);
    const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
    let match;
    while (match = attributePattern.exec(source)) {
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
  var HtmlNode = class {
    constructor(tag, attributes = /* @__PURE__ */ Object.create(null), parent = null) {
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
      const selectors = String(selector).split(",").map((item) => item.trim()).filter(Boolean);
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
  };
  function parseFallbackHtml(html) {
    const root = new HtmlNode("#root");
    const stack = [root];
    const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>/gu;
    let cursor = 0;
    let token;
    const appendText = (value) => {
      if (!value) return;
      const node = new HtmlNode("#text", /* @__PURE__ */ Object.create(null), stack[stack.length - 1]);
      node.text = decodeHtmlEntities(value);
      stack[stack.length - 1].children.push(node);
    };
    while (token = tokenPattern.exec(String(html ?? ""))) {
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
  function collectCardProducts(document2) {
    const cards = [];
    let sectionRarity = null;
    for (const element of queryAll(document2, "h3, .card-product")) {
      if (hasClass(element, "card-product")) cards.push({ element, sectionRarity });
      else sectionRarity = readSectionRarity(element);
    }
    return cards;
  }
  function parseSearchResults(html, options = {}) {
    const source = String(html ?? "");
    const document2 = getBrowserDocument(source, options) ?? parseFallbackHtml(source);
    const cardElements = collectCardProducts(document2);
    const products = [];
    const rejected = [];
    for (const { element, sectionRarity } of cardElements) {
      const parsed = parseProductElementDetailed(element, sectionRarity);
      if (parsed.product) products.push(parsed.product);
      else rejected.push(parsed.error);
    }
    const explicitEmpty = looksLikeExplicitEmptyResult(source);
    const onlyDamagedCandidates = cardElements.length > 0 && rejected.length > 0 && rejected.every((error) => error?.code === "PRODUCT_DAMAGED");
    const structureError = cardElements.length > 0 && products.length === 0 && !onlyDamagedCandidates || cardElements.length === 0 && source.trim() !== "" && !explicitEmpty;
    return {
      products,
      candidates: products,
      rejected,
      cardProductCount: cardElements.length,
      structureError,
      explicitEmpty,
      document: document2
    };
  }

  // src/core/lookup.js
  var LOOKUP_ERROR_CODES = Object.freeze({
    NETWORK: ERROR_CODES.LOOKUP_NETWORK,
    HTTP: ERROR_CODES.LOOKUP_HTTP,
    SITE_CHANGED: ERROR_CODES.LOOKUP_SITE_CHANGED
  });
  var LookupError = class extends YytError {
    constructor(code, message, details = {}) {
      super(code, message, details);
      this.name = "LookupError";
      Object.assign(this, details);
    }
  };
  function requestId(value) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    const originals = Array.isArray(value.originalIds) ? value.originalIds : [];
    return String(
      value.originalId ?? value.printedId ?? value.id ?? originals[0] ?? value.normalizedId ?? ""
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
    return (typeof value === "number" || typeof value === "string") && /^\d+$/u.test(String(value).trim()) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 99;
  }
  function makeRequest(value, index) {
    const printedId = requestId(value);
    const normalizedId = normalizePrintedId2(
      value && typeof value === "object" && value.normalizedId ? value.normalizedId : printedId
    );
    const rawQuantity = requestQuantity(value);
    const validQuantity = isValidQuantity(rawQuantity);
    const requestedQuantity = validQuantity ? Number(rawQuantity) : Number(rawQuantity) || 0;
    const originals = value && typeof value === "object" && Array.isArray(value.originalIds) ? value.originalIds.map((id) => String(id)) : printedId ? [printedId] : [];
    const condition = value && typeof value === "object" && typeof value.condition === "string" ? value.condition : null;
    const rarity = value && typeof value === "object" ? normalizeRarity(value.rarity) : null;
    return {
      originalId: printedId || originals[0] || String(value?.normalizedId ?? ""),
      originalIds: originals,
      normalizedId,
      ...condition ? { condition } : {},
      ...rarity ? { rarity } : {},
      requestedQuantity,
      sourceLines: sourceLines(value),
      inputIndex: index,
      invalid: !printedId || !normalizedId || !validQuantity,
      invalidReason: !printedId ? "missing printed ID" : !validQuantity ? "quantity must be an integer from 1 through 99" : null
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
    const byId = /* @__PURE__ */ new Map();
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
  function getSearchPrefix(value) {
    const id = requestId(value);
    const dash = id.indexOf("-");
    const slash = id.indexOf("/");
    if (dash <= 0 || slash <= 0 || slash >= dash) return null;
    const prefix = id.slice(0, dash).trim();
    if (!prefix || /\s/u.test(prefix)) return null;
    return prefix;
  }
  function groupIdsByPrefix(values) {
    if (!Array.isArray(values)) throw new TypeError("values must be an array");
    const groups = /* @__PURE__ */ new Map();
    const canonicalKeys = /* @__PURE__ */ new Map();
    for (const value of values) {
      const prefix = getSearchPrefix(value);
      if (!prefix) continue;
      const canonical = normalizePrintedId2(prefix);
      const key = canonicalKeys.get(canonical) ?? prefix;
      canonicalKeys.set(canonical, key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    }
    return groups;
  }
  function getFetch(options) {
    const fetchFunction = options.fetch ?? options.fetchFn ?? options.fetchImpl;
    if (typeof fetchFunction === "function") return fetchFunction;
    if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") {
      return globalThis.fetch.bind(globalThis);
    }
    throw new LookupError(
      LOOKUP_ERROR_CODES.NETWORK,
      "No fetch implementation is available for YYT search"
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
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1e3, 3e4);
    const date = Date.parse(String(header));
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 3e4));
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
  async function fetchSearchPage(query, options = {}) {
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
          ...options.signal ? { signal: options.signal } : {}
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
          { cause: error, query: String(query), url }
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
          { query: String(query), url, status }
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
          url
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
        explicitEmpty: parsed.length === 0
      };
    }
    return parsed;
  }
  function matchingProducts(products, normalizedIds) {
    const byId = /* @__PURE__ */ new Map();
    for (const product of products ?? []) {
      const printedId = product?.printedId;
      const normalizedId = product?.normalizedId ?? normalizePrintedId2(printedId);
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
      stock: availableStock
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
      condition: request.condition ?? null
    };
  }
  function makeMissingRow(request, reason = "PRODUCT_MISSING") {
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
      condition: request.condition ?? null
    };
  }
  function makeAmbiguousRow(request, candidates) {
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
      candidates,
      condition: request.condition ?? null
    };
  }
  function buildRow(request, product, plannedQuantity, stock, statusOverride = null) {
    const soldOut = Boolean(product.soldOut) || stock <= 0;
    const status = statusOverride ? statusOverride : soldOut ? "sold-out" : plannedQuantity < request.requestedQuantity ? "partial" : "ready";
    return {
      ...request,
      status,
      reason: status === "ready" ? null : status === "partial" ? "PRODUCT_PARTIAL_STOCK" : "PRODUCT_SOLD_OUT",
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
      candidates: [product]
    };
  }
  function makeSingleRow(request, product, requestedQuantity) {
    const numbers = numbersForProduct(product);
    const soldOut = Boolean(product.soldOut) || numbers.stock <= 0;
    const plannedQuantity = soldOut ? 0 : Math.min(requestedQuantity, numbers.stock);
    const status = soldOut ? "sold-out" : plannedQuantity < requestedQuantity ? "partial" : "ready";
    return buildRow(request, product, plannedQuantity, numbers.stock, status);
  }
  function isResolvedRow(row) {
    return row.status === "ready" || row.status === "partial";
  }
  function asOption(row, reason) {
    if (!row.product) return row;
    return {
      ...row,
      status: row.status === "sold-out" ? "sold-out" : "option",
      reason: row.status === "sold-out" ? "PRODUCT_SOLD_OUT" : reason,
      plannedQuantity: 0,
      selected: false,
      isOption: true
    };
  }
  function productKey(product) {
    return product ? [product.ver, product.cid, product.kizu].join("|") : null;
  }
  function dropDuplicateOptions(rows) {
    const resolved = new Set(rows.filter((row) => row.product && !row.isOption).map((row) => productKey(row.product)));
    const offered = /* @__PURE__ */ new Set();
    return rows.filter((row) => {
      if (!row.isOption) return true;
      const key = productKey(row.product);
      if (resolved.has(key) || offered.has(key)) return false;
      offered.add(key);
      return true;
    });
  }
  function groupByRarity(candidates) {
    const groups = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      const rarity = normalizeRarity(candidate.rarity);
      if (!groups.has(rarity)) groups.set(rarity, []);
      groups.get(rarity).push(candidate);
    }
    return [...groups].map(([rarity, products]) => ({ rarity, products }));
  }
  function makeRows(request, candidates, options = {}) {
    if (request.invalid) return [makeInvalidRow(request)];
    const exact = candidates ?? [];
    if (exact.length === 0) {
      return [makeMissingRow(request)];
    }
    if (request.rarity) {
      const matching = exact.filter((c) => normalizeRarity(c.rarity) === request.rarity);
      if (matching.length === 0) return [makeMissingRow(request, "PRODUCT_RARITY_MISSING")];
      return makeConditionRows(request, matching, options);
    }
    const groups = groupByRarity(exact);
    if (groups.length === 1) return makeConditionRows(request, exact, options);
    if (groups.some((group) => group.rarity == null)) return [makeAmbiguousRow(request, exact)];
    const rowsByGroup = groups.map((group) => makeConditionRows(request, group.products, options));
    const primaryIndex = Math.max(0, rowsByGroup.findIndex((rows) => rows.some(isResolvedRow)));
    const rarities = groups.map((group) => group.rarity);
    return rowsByGroup.flatMap(
      (rows, index) => rows.filter((row) => index === primaryIndex || row.status !== "missing").map((row) => ({
        ...index === primaryIndex ? row : asOption(row, "PRODUCT_OTHER_RARITY"),
        otherRarities: rarities.filter((rarity) => rarity !== groups[index].rarity)
      }))
    );
  }
  function makeConditionRows(request, exact, options) {
    const normal = exact.filter((c) => String(c.kizu).trim() === "0");
    const damaged = exact.filter((c) => String(c.kizu).trim() !== "0");
    const preference = options.conditionPreference || "prefer-normal";
    const strict = request.condition ?? (preference === "normal-only" ? "normal" : preference === "damaged-only" ? "damaged" : null);
    if (strict) {
      const [wanted, other] = strict === "normal" ? [normal, damaged] : [damaged, normal];
      if (wanted.length > 1) return [makeAmbiguousRow(request, wanted)];
      const primary = wanted.length ? makeSingleRow(request, wanted[0], request.requestedQuantity) : { ...makeMissingRow(request, "PRODUCT_CONDITION_MISSING"), condition: strict };
      if (other.length !== 1) return [primary];
      const otherRow = buildRow(request, other[0], 0, numbersForProduct(other[0]).stock);
      return [primary, asOption(otherRow, "PRODUCT_OTHER_CONDITION")];
    }
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
      const totalRequested = request.requestedQuantity;
      const normalStock = numbersForProduct(normal[0]).stock;
      const damagedStock = numbersForProduct(damaged[0]).stock;
      if (preference === "prefer-damaged") {
        const damagedPlanned = Math.min(totalRequested, damagedStock);
        const normalPlanned = Math.min(Math.max(0, totalRequested - damagedPlanned), normalStock);
        const totalAllocated = damagedPlanned + normalPlanned;
        const damagedStatus = damagedStock <= 0 ? "sold-out" : totalAllocated < totalRequested ? "partial" : "ready";
        const normalStatus = normalStock <= 0 ? "sold-out" : totalAllocated < totalRequested ? "partial" : "ready";
        const damagedRow = buildRow(request, damaged[0], damagedPlanned, damagedStock, damagedStatus);
        damagedRow.selected = damagedPlanned > 0;
        const normalRow = buildRow(request, normal[0], normalPlanned, normalStock, normalStatus);
        normalRow.selected = normalPlanned > 0;
        return [damagedRow, normalPlanned > 0 ? normalRow : asOption(normalRow, "PRODUCT_OTHER_CONDITION")];
      } else {
        const normalPlanned = Math.min(totalRequested, normalStock);
        const damagedPlanned = Math.min(Math.max(0, totalRequested - normalPlanned), damagedStock);
        const totalAllocated = normalPlanned + damagedPlanned;
        const normalStatus = normalStock <= 0 ? "sold-out" : totalAllocated < totalRequested ? "partial" : "ready";
        const damagedStatus = damagedStock <= 0 ? "sold-out" : totalAllocated < totalRequested ? "partial" : "ready";
        const normalRow = buildRow(request, normal[0], normalPlanned, normalStock, normalStatus);
        normalRow.selected = normalPlanned > 0;
        const damagedRow = buildRow(request, damaged[0], damagedPlanned, damagedStock, damagedStatus);
        damagedRow.selected = damagedPlanned > 0;
        return [normalRow, damagedPlanned > 0 ? damagedRow : asOption(damagedRow, "PRODUCT_OTHER_CONDITION")];
      }
    }
    return [makeMissingRow(request)];
  }
  async function delayBetweenQueries(options, queryNumber) {
    const delay = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 250;
    if (queryNumber > 0) await sleep(delay, options);
  }
  function queryExpectedIds(values) {
    return new Set(values.map((value) => normalizePrintedId2(requestId(value))).filter(Boolean));
  }
  function assertStructure(parsed, query, expectedIds) {
    if (!parsed?.structureError) return;
    const matching = matchingProducts(parsed.products, expectedIds);
    const allCandidatesInvalid = parsed.cardProductCount > 0 && parsed.products.length === 0;
    const noCardMarkup = parsed.cardProductCount === 0 && !parsed.explicitEmpty;
    if (allCandidatesInvalid || noCardMarkup && matching.size === 0) {
      throw new LookupError(
        LOOKUP_ERROR_CODES.SITE_CHANGED,
        `YYT search structure could not be parsed for ${query}`,
        {
          query,
          rejected: parsed.rejected ?? []
        }
      );
    }
  }
  async function lookupProducts(requests, options = {}) {
    const normalizedRequests = normalizeRequests(requests);
    const validRequests = normalizedRequests.filter((request) => !request.invalid);
    const expectedIds = new Set(validRequests.map((request) => request.normalizedId));
    const candidatesById = /* @__PURE__ */ new Map();
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
        productCount: parsed.products.length
      });
    }
    for (const request of validRequests) {
      if (!candidatesById.has(request.normalizedId)) fallbackIds.push(request);
    }
    const exactFallbacks = [];
    const fallbackSeen = /* @__PURE__ */ new Set();
    for (const request of fallbackIds) {
      if (fallbackSeen.has(request.normalizedId)) continue;
      fallbackSeen.add(request.normalizedId);
      exactFallbacks.push(request);
    }
    for (const request of exactFallbacks) {
      await delayBetweenQueries(options, queryNumber);
      queryNumber += 1;
      const page = await fetchSearchPage(request.originalId, options);
      const parsed = parserReport(page.html, { ...options, expectedIds: /* @__PURE__ */ new Set([request.normalizedId]) });
      assertStructure(parsed, request.originalId, /* @__PURE__ */ new Set([request.normalizedId]));
      const matches = matchingProducts(parsed.products, expectedIds);
      mergeCandidates(candidatesById, matches);
      queries.push({
        type: "exact",
        query: request.originalId,
        url: page.url,
        status: page.status,
        cardProductCount: parsed.cardProductCount,
        productCount: parsed.products.length
      });
    }
    const rows = dropDuplicateOptions(
      normalizedRequests.flatMap(
        (request) => makeRows(request, candidatesById.get(request.normalizedId), options)
      )
    );
    return {
      rows,
      items: rows,
      results: rows,
      requests: normalizedRequests,
      queries,
      candidatesById
    };
  }

  // src/core/cart.js
  var CART_ERROR_CODES = ERROR_CODES;
  var DEFAULT_CART_DELAY_MS = 750;
  var CART_ENDPOINT = "/api/cart_order_edit";
  var CSRF_FALLBACK_ENDPOINT = "/top/ws";
  var CART_SUCCESS_STATUS = "SUCCESS";
  var MAX_REPORT_MESSAGE_LENGTH = 180;
  var CartError = class extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "CartError";
      this.code = code;
      this.responseStatus = details.responseStatus ?? null;
      this.stopBatch = details.stopBatch ?? true;
      if (details.cause !== void 0) {
        this.cause = details.cause;
      }
    }
  };
  function defaultDocument() {
    return typeof document === "undefined" ? null : document;
  }
  function defaultFetch() {
    if (typeof globalThis === "undefined" || typeof globalThis.fetch !== "function") {
      return null;
    }
    return globalThis.fetch.bind(globalThis);
  }
  function getFetchImplementation(options = {}) {
    return options.fetchImpl ?? options.fetch ?? options.fetchFn ?? defaultFetch();
  }
  function cleanToken(value) {
    if (typeof value !== "string") {
      return null;
    }
    const token = value.trim();
    return token === "" ? null : token;
  }
  function extractCsrfToken(documentRef = defaultDocument()) {
    if (!documentRef || typeof documentRef.querySelector !== "function") {
      return null;
    }
    let meta;
    try {
      meta = documentRef.querySelector('meta[name="csrf-token"]');
    } catch {
      return null;
    }
    if (!meta) {
      return null;
    }
    let value = null;
    if (typeof meta.getAttribute === "function") {
      value = meta.getAttribute("content");
    }
    if (value == null && "content" in meta) {
      value = meta.content;
    }
    return cleanToken(value);
  }
  function parseDocumentHtml(html, options = {}) {
    if (typeof options.parseHtml === "function") {
      return options.parseHtml(html);
    }
    const Parser = options.DOMParserImpl ?? options.DOMParser ?? (typeof DOMParser === "undefined" ? null : DOMParser);
    if (Parser) {
      return new Parser().parseFromString(html, "text/html");
    }
    return null;
  }
  function extractCsrfTokenFromHtml(html, options = {}) {
    if (typeof html !== "string") {
      return null;
    }
    let parsed = null;
    try {
      parsed = parseDocumentHtml(html, options);
    } catch {
      parsed = null;
    }
    const fromDocument = extractCsrfToken(parsed);
    if (fromDocument) {
      return fromDocument;
    }
    const metaTagPattern = /<meta\b[^>]*>/gi;
    const tags = html.match(metaTagPattern) ?? [];
    for (const tag of tags) {
      const nameMatch = /\bname\s*=\s*(["'])csrf-token\1/i.exec(tag);
      if (!nameMatch) {
        continue;
      }
      const contentMatch = /\bcontent\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i.exec(tag);
      const rawToken = contentMatch?.[2] ?? contentMatch?.[3] ?? null;
      const token = cleanToken(String(rawToken ?? "").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'"));
      if (token) {
        return token;
      }
    }
    return null;
  }
  async function getCsrfToken(options = {}) {
    options = options ?? {};
    const documentRef = options.documentRef ?? options.document ?? defaultDocument();
    const fromCurrentPage = extractCsrfToken(documentRef);
    if (fromCurrentPage) {
      return fromCurrentPage;
    }
    const fetchImpl = getFetchImplementation(options);
    if (typeof fetchImpl !== "function") {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "A CSRF token is required before adding items to the cart."
      );
    }
    const request = {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "text/html" }
    };
    if (options.signal !== void 0) {
      request.signal = options.signal;
    }
    let response;
    try {
      response = await fetchImpl(CSRF_FALLBACK_ENDPOINT, request);
    } catch (error) {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "The CSRF token could not be loaded. Nothing was added to the cart.",
        { cause: error }
      );
    }
    const responseStatus2 = numericResponseStatus(response);
    if (!responseIsOk(response)) {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "The CSRF token could not be loaded. Nothing was added to the cart.",
        { responseStatus: responseStatus2 }
      );
    }
    let html;
    try {
      html = await response.text();
    } catch (error) {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "The CSRF token could not be loaded. Nothing was added to the cart.",
        { responseStatus: responseStatus2, cause: error }
      );
    }
    const token = extractCsrfTokenFromHtml(String(html), options);
    if (!token) {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "The page did not expose a usable CSRF token. Nothing was added to the cart.",
        { responseStatus: responseStatus2 }
      );
    }
    return token;
  }
  function numericResponseStatus(response) {
    const status = Number(response?.status);
    return Number.isFinite(status) && status > 0 ? status : null;
  }
  function responseIsOk(response) {
    if (typeof response?.ok === "boolean") {
      return response.ok;
    }
    const status = numericResponseStatus(response);
    return status !== null && status >= 200 && status < 300;
  }
  function parseInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    let candidate = value;
    if (typeof candidate === "string") {
      candidate = candidate.trim();
      if (!/^\d+$/.test(candidate)) {
        throw new CartError(
          CART_ERROR_CODES.CART_REJECTED,
          `${label} must be an integer.`
        );
      }
      candidate = Number(candidate);
    }
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
      throw new CartError(
        CART_ERROR_CODES.CART_REJECTED,
        `${label} must be an integer between ${min} and ${max}.`
      );
    }
    return candidate;
  }
  function validateQuantity(value) {
    try {
      return parseInteger(value, "Cart quantity", { min: 1, max: 99 });
    } catch (error) {
      if (error instanceof CartError) {
        error.code = CART_ERROR_CODES.INPUT_INVALID;
      }
      throw error;
    }
  }
  function productId(product) {
    const value = product?.normalizedId ?? product?.printedId ?? "";
    return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
  }
  function resultBase(item, attemptedQuantity = 0) {
    const product = item?.product ?? item ?? {};
    const normalizedId = item?.normalizedId ?? productId(product);
    const requestedQuantity = item?.requestedQuantity ?? product?.requestedQuantity ?? null;
    return {
      normalizedId: typeof normalizedId === "string" ? normalizedId.trim().toLocaleLowerCase("en-US") : "",
      attemptedQuantity,
      ...requestedQuantity == null ? {} : { requestedQuantity }
    };
  }
  function skippedResult(item, code, message, attemptedQuantity = 0) {
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "skipped",
      message,
      responseStatus: null,
      code,
      errorCode: code,
      stopBatch: false
    };
  }
  function responseMessage(parsed, fallback) {
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidates = [parsed.message, parsed.error, parsed.detail, parsed.reason];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
          return sanitizeReportMessage(candidate);
        }
      }
    }
    return fallback;
  }
  function sanitizeReportMessage(value) {
    return String(value).replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/(?:x-)?csrf[-_\s]?token\s*[:=]\s*[^\s,;]+/gi, "[redacted]").replace(/(?:access|refresh)?token\s*[:=]\s*[^\s,;]+/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(0, MAX_REPORT_MESSAGE_LENGTH);
  }
  function itemSpecificResponse(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const status = typeof parsed.status === "string" ? parsed.status.toUpperCase() : "";
    if (!status || status === CART_SUCCESS_STATUS) {
      return false;
    }
    const text = [parsed.status, parsed.code, parsed.message, parsed.error, parsed.reason].filter((value) => typeof value === "string").join(" ");
    return /(stock|sold[ -]?out|inventory|quantity|limit|product|card|商品|在庫|売り切れ|個数)/i.test(text);
  }
  function classifyHttpFailure(status, parsed, responseOk2) {
    if (status === 403 || status === 419) {
      return {
        code: CART_ERROR_CODES.CART_AUTH,
        stopBatch: true,
        message: "The cart request was rejected by authentication or CSRF protection."
      };
    }
    if (status === 429) {
      return {
        code: CART_ERROR_CODES.CART_RATE_LIMIT,
        stopBatch: true,
        message: "YYT rate-limited the cart request; the batch was stopped."
      };
    }
    if (status !== null && status >= 500) {
      return {
        code: CART_ERROR_CODES.CART_SERVER,
        stopBatch: true,
        message: "YYT returned a server error; the batch was stopped."
      };
    }
    const specific = itemSpecificResponse(parsed);
    const structurallyInvalid = responseOk2 && (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.status !== "string");
    return {
      // A parsed non-success payload is a definite rejection, even when YYT
      // labels it HTTP 200.  `CART_RESPONSE_INVALID` is reserved for malformed
      // or structurally unusable payloads.
      code: structurallyInvalid ? CART_ERROR_CODES.CART_RESPONSE_INVALID : CART_ERROR_CODES.CART_REJECTED,
      stopBatch: !specific,
      message: responseMessage(
        parsed,
        responseOk2 ? "YYT returned an unexpected cart response." : "YYT rejected this cart item."
      )
    };
  }
  async function parseCartResponse(response, item = {}, attemptedQuantity = 0) {
    const responseStatus2 = numericResponseStatus(response);
    let text;
    try {
      text = await response.text();
    } catch {
      if (!responseIsOk(response)) {
        const classification2 = classifyHttpFailure(responseStatus2, null, false);
        return {
          ...resultBase(item, attemptedQuantity),
          outcome: "failed",
          message: classification2.message,
          responseStatus: responseStatus2,
          code: classification2.code,
          errorCode: classification2.code,
          stopBatch: classification2.stopBatch
        };
      }
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "unknown",
        message: "The cart response was interrupted; inspect /cart/sell before retrying.",
        responseStatus: responseStatus2,
        code: CART_ERROR_CODES.CART_OUTCOME_UNKNOWN,
        errorCode: CART_ERROR_CODES.CART_OUTCOME_UNKNOWN,
        stopBatch: true
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(String(text).replace(/^\uFEFF/u, ""));
    } catch {
      const code = responseIsOk(response) ? CART_ERROR_CODES.CART_RESPONSE_INVALID : classifyHttpFailure(responseStatus2, null, responseIsOk(response)).code;
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "failed",
        message: responseIsOk(response) ? "YYT returned an invalid cart response." : "YYT rejected this cart item with an unreadable response.",
        responseStatus: responseStatus2,
        code,
        errorCode: code,
        stopBatch: true
      };
    }
    if (responseIsOk(response) && parsed?.status === CART_SUCCESS_STATUS) {
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "success",
        message: `Added ${attemptedQuantity}`,
        responseStatus: responseStatus2,
        code: null,
        errorCode: null,
        stopBatch: false
      };
    }
    const classification = classifyHttpFailure(responseStatus2, parsed, responseIsOk(response));
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "failed",
      message: classification.message,
      responseStatus: responseStatus2,
      code: classification.code,
      errorCode: classification.code,
      stopBatch: classification.stopBatch
    };
  }
  function validateProduct(product) {
    if (!product || typeof product !== "object") {
      throw new CartError(CART_ERROR_CODES.CART_REJECTED, "The resolved product is missing.");
    }
    for (const field of ["gid", "ver", "cid"]) {
      if (product[field] == null || String(product[field]).trim() === "") {
        throw new CartError(
          CART_ERROR_CODES.CART_REJECTED,
          "The resolved product is missing a required cart field."
        );
      }
    }
    if (product.kizu != null && !/^\d+$/u.test(String(product.kizu).trim())) {
      throw new CartError(
        CART_ERROR_CODES.CART_REJECTED,
        "The resolved product has an invalid condition code."
      );
    }
  }
  function availableQuantity(product) {
    const values = [];
    for (const field of [
      "stock",
      "availableStock",
      "cart_active",
      "cartActive",
      "limit",
      "cart_limit",
      "cartLimit"
    ]) {
      if (!(field in product) || product[field] == null || product[field] === "") {
        continue;
      }
      try {
        values.push(parseInteger(product[field], field, { min: 0 }));
      } catch {
        throw new CartError(
          CART_ERROR_CODES.CART_REJECTED,
          "The resolved product has invalid stock information."
        );
      }
    }
    return values.length === 0 ? null : Math.min(...values);
  }
  function prepareQuantity(product, plannedQuantity) {
    const requested = validateQuantity(plannedQuantity);
    const available = availableQuantity(product);
    if (available === 0 || product.soldOut === true || product.available === false) {
      throw new CartError(
        CART_ERROR_CODES.PRODUCT_SOLD_OUT,
        "This product is no longer available in normal condition."
      );
    }
    return available == null ? requested : Math.min(requested, available, 99);
  }
  function timestampValue(now) {
    const value = typeof now === "function" ? now() : now ?? /* @__PURE__ */ new Date();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new CartError(CART_ERROR_CODES.CART_REJECTED, "Unable to create the cart request timestamp.");
    }
    return date.toISOString();
  }
  function buildCartRequest(product, plannedQuantity, csrfToken, options = {}) {
    let config = typeof options === "function" ? { now: options } : options ?? {};
    let tokenValue = csrfToken;
    if (csrfToken && typeof csrfToken === "object") {
      config = { ...csrfToken, ...config };
      tokenValue = config.csrfToken ?? config.token;
    }
    validateProduct(product);
    const quantity = prepareQuantity(product, plannedQuantity);
    const token = cleanToken(tokenValue);
    if (!token) {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "A CSRF token is required before adding items to the cart."
      );
    }
    const body = new URLSearchParams({
      gid: String(product.gid),
      ver: String(product.ver),
      cid: String(product.cid),
      mode: "add",
      type: "sell",
      counter: String(quantity),
      kizu: String(product.kizu ?? "0"),
      time: timestampValue(config.now)
    });
    const request = {
      url: config.url ?? CART_ENDPOINT,
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-TOKEN": token,
        "X-Requested-With": "XMLHttpRequest"
      },
      body,
      quantity
    };
    if (config.signal !== void 0) {
      request.signal = config.signal;
    }
    return request;
  }
  function unknownResult(item, attemptedQuantity, responseStatus2 = null) {
    const code = CART_ERROR_CODES.CART_OUTCOME_UNKNOWN;
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "unknown",
      message: "The cart request outcome is unknown; inspect /cart/sell before retrying.",
      responseStatus: responseStatus2,
      code,
      errorCode: code,
      stopBatch: true
    };
  }
  function localValidationResult(item, error) {
    const code = error?.code ?? CART_ERROR_CODES.CART_REJECTED;
    const message = error?.message ?? "This item could not be added.";
    return skippedResult(item, code, message);
  }
  async function addCartItem(productOrItem, plannedQuantity, options = {}) {
    let itemOptions = options ?? {};
    let quantityValue = plannedQuantity;
    if (plannedQuantity && typeof plannedQuantity === "object") {
      itemOptions = { ...plannedQuantity, ...options };
      quantityValue = itemOptions.plannedQuantity ?? itemOptions.quantity;
    } else if (typeof plannedQuantity === "string" && !/^\d+$/u.test(plannedQuantity.trim())) {
      itemOptions = { csrfToken: plannedQuantity, ...options };
      quantityValue = productOrItem?.plannedQuantity ?? productOrItem?.requestedQuantity ?? productOrItem?.product?.plannedQuantity ?? productOrItem?.product?.requestedQuantity;
    }
    const item = productOrItem?.product ? productOrItem : { product: productOrItem };
    const product = item.product ?? {};
    const signal = itemOptions.signal;
    if (signal?.aborted) {
      return skippedResult(item, CART_ERROR_CODES.CANCELLED, "Cancelled before the cart request was sent.");
    }
    let request;
    try {
      const csrfToken = itemOptions.csrfToken ?? itemOptions.token;
      request = buildCartRequest(product, quantityValue, csrfToken, {
        now: itemOptions.now,
        url: itemOptions.url,
        signal
      });
    } catch (error) {
      return localValidationResult(item, error);
    }
    const fetchImpl = getFetchImplementation(itemOptions);
    if (typeof fetchImpl !== "function") {
      return unknownResult(item, request.quantity);
    }
    let response;
    try {
      const { quantity: _quantity, ...requestInit } = request;
      response = await fetchImpl(request.url, requestInit);
    } catch {
      return unknownResult(item, request.quantity);
    }
    return parseCartResponse(response, item, request.quantity);
  }

  // src/ui/styles.js
  var styles = `
:host { all: initial; color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
button, textarea, input { font: inherit; }
.launcher { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; border: 0; border-radius: 999px; padding: 12px 18px; background: #17365d; color: #fff; font: 700 14px/1.2 system-ui, sans-serif; box-shadow: 0 4px 16px #0004; cursor: pointer; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 18px; background: #10182899; font: 14px/1.45 system-ui, sans-serif; color: #182230; }
.backdrop[hidden] { display: none; }
.panel { width: min(1050px, 100%); max-height: min(90vh, 900px); overflow: auto; border-radius: 14px; background: #fff; box-shadow: 0 20px 60px #0007; }
.header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #d8dee8; background: #fff; }
h2, h3, p { margin: 0; }
h2 { font-size: 20px; }
h3 { margin-bottom: 10px; font-size: 17px; }
.body { padding: 20px; }
.view { display: grid; gap: 16px; }
.hint { color: #475467; }
.warning { padding: 10px 12px; border-left: 4px solid #b54708; background: #fff4e8; font-weight: 650; white-space: pre-wrap; }
.warning[hidden] { display: none; }
.error { padding: 10px 12px; border-left: 4px solid #b42318; background: #fef3f2; color: #912018; white-space: pre-wrap; }
label { display: grid; gap: 7px; font-weight: 650; }
textarea { width: 100%; min-height: 220px; resize: vertical; border: 1px solid #98a2b3; border-radius: 8px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-weight: 400; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
button { border: 1px solid #98a2b3; border-radius: 7px; padding: 9px 13px; background: #fff; color: #182230; cursor: pointer; }
button.primary { border-color: #17365d; background: #17365d; color: #fff; font-weight: 700; }
button.danger { border-color: #b42318; color: #b42318; }
button:disabled { cursor: not-allowed; opacity: .48; }
button:focus-visible, textarea:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid #84caff; outline-offset: 2px; }
.close { padding: 5px 9px; font-size: 18px; }
.table-wrap { overflow-x: auto; border: 1px solid #d8dee8; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 9px; border-bottom: 1px solid #e4e7ec; text-align: left; vertical-align: top; }
th { background: #f7f9fc; white-space: nowrap; }
tr.partial { background: #fff8e8; }
tr.unavailable { color: #667085; background: #f8fafc; }
tr.alt { background: #f5f8ff; }
tr.alt td:first-child { box-shadow: inset 3px 0 #84adff; }
td.rarity { white-space: nowrap; }
tr.alt td.rarity { padding-left: 14px; }
tr.over { background: #fef3f2; }
.num { text-align: right; white-space: nowrap; }
.status { font-weight: 700; }
.summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 12px; border-radius: 8px; background: #f1f5f9; }
.progress { width: 100%; height: 12px; }
.result-group { padding: 12px; border: 1px solid #d8dee8; border-radius: 8px; }
.result-group ul { margin: 8px 0 0; padding-left: 20px; }
a { color: #175cd3; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
.badge-normal { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.badge-damaged { background: #fffaeb; color: #b54708; border: 1px solid #fedf89; }
.qty-input { width: 56px; padding: 3px 5px; border: 1px solid #98a2b3; border-radius: 5px; text-align: right; font-size: 13px; }
.select-pref { width: 100%; padding: 8px 10px; border: 1px solid #98a2b3; border-radius: 7px; font-size: 14px; background: #fff; }
@media (max-width: 600px) { .backdrop { padding: 0; place-items: stretch; } .panel { width: 100%; max-height: 100vh; border-radius: 0; } .body { padding: 14px; } .launcher { right: 10px; bottom: 10px; } }
`;

  // src/ui/app.js
  var yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(key, "");
      else if (value !== false && value != null) node.setAttribute(key, String(value));
    }
    node.append(...children.filter(Boolean));
    return node;
  }
  function statusReason(row) {
    const cond = row.condition === "damaged" ? "damaged" : "normal";
    const also = row.otherRarities?.length ? ` (also sold as ${row.otherRarities.join(", ")})` : "";
    const messages = {
      ready: `Ready${also}`,
      option: row.reason === "PRODUCT_OTHER_CONDITION" ? `${cond === "damaged" ? "Damaged" : "Normal"} copy; set a quantity to add` : `Same ID in another rarity${also}; set a quantity to add`,
      partial: `Requested ${row.requestedQuantity}; adding ${row.plannedQuantity}`,
      "sold-out": `Card is sold out in ${cond} condition`,
      missing: row.reason === "PRODUCT_RARITY_MISSING" ? `No ${row.rarity} product for this ID` : row.reason === "PRODUCT_CONDITION_MISSING" ? `No ${cond} copy for this ID` : "No exact card found",
      ambiguous: "Multiple exact products found; skipped",
      invalid: row.reason || "Invalid input"
    };
    return messages[row.status] || row.reason || row.status;
  }
  function mountApp({ parse, resolve, getCsrfToken: getCsrfToken2, addItem, mutationDelayMs = 750 }) {
    const host = document.createElement("div");
    host.id = "yyt-cart-adder-host";
    document.documentElement.append(host);
    const root = host.attachShadow({ mode: "closed" });
    root.append(el("style", { text: styles }));
    const launcher = el("button", { className: "launcher", type: "button", text: "Bulk add WS cards" });
    const title = el("h2", { id: "yyt-bulk-title", text: "YYT Weiss Schwarz cart adder" });
    const closeButton = el("button", { className: "close", type: "button", text: "\xD7", "aria-label": "Close" });
    const body = el("div", { className: "body" });
    const panel = el(
      "section",
      { className: "panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "yyt-bulk-title" },
      el("header", { className: "header" }, title, closeButton),
      body
    );
    const backdrop = el("div", { className: "backdrop", hidden: true }, panel);
    root.append(launcher, backdrop);
    let previousFocus = null;
    let lookupController = null;
    let addController = null;
    let cancelRequested = false;
    let adding = false;
    const setView = (...nodes) => body.replaceChildren(el("div", { className: "view" }, ...nodes));
    const close = () => {
      if (adding && !cancelRequested) cancelRequested = true;
      lookupController?.abort();
      backdrop.hidden = true;
      previousFocus?.focus?.();
    };
    const open = () => {
      previousFocus = document.activeElement;
      backdrop.hidden = false;
      showInput();
    };
    launcher.addEventListener("click", open);
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && !backdrop.hidden) {
        const focusable = [...panel.querySelectorAll("button:not(:disabled), textarea, input:not(:disabled), a[href]")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && root.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && root.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    function showInput(saved = "", savedPref = "prefer-normal") {
      adding = false;
      cancelRequested = false;
      const input = el("textarea", { id: "yyt-card-list", placeholder: "Kka/W102-005SEC 1\nKka/W102-006 2 damaged\nRZ/SE35-01 1 S-RR" });
      input.value = saved;
      const prefSelect = el(
        "select",
        { id: "yyt-condition-preference", className: "select-pref" },
        el("option", { value: "prefer-normal", text: "Normal first, damaged if not enough stock" }),
        el("option", { value: "prefer-damaged", text: "Damaged first, normal if not enough stock" }),
        el("option", { value: "normal-only", text: "Normal only" }),
        el("option", { value: "damaged-only", text: "Damaged only" })
      );
      prefSelect.value = savedPref;
      const errorBox = el("div", { className: "error", hidden: true });
      const resolveButton = el("button", { className: "primary", type: "button", text: "Resolve cards" });
      resolveButton.addEventListener("click", async () => {
        let parsed;
        try {
          parsed = parse(input.value);
        } catch (error) {
          errorBox.hidden = false;
          errorBox.textContent = error.message || "Could not parse input.";
          return;
        }
        if (!parsed.requests.length) {
          const errList = parsed.invalid || parsed.errors || [];
          errorBox.hidden = false;
          errorBox.textContent = errList.length ? errList.map((x) => `Line ${x.lineNumber}: ${x.reason || x.message}`).join("\n") : "Enter at least one card ID.";
          return;
        }
        await showResolving(parsed, input.value, prefSelect.value);
      });
      setView(
        el("p", { className: "warning", text: "Quantities below will be added to anything already in your cart." }),
        el("p", { className: "hint", text: "One exact printed card ID per line; quantity defaults to 1. Append 'damaged'/1 or 'normal'/0 to fix a line's condition (this overrides the setting above), and a rarity such as RR or S-RR when an ID is sold in more than one. Lines beginning with # are ignored." }),
        el("label", { for: "yyt-condition-preference", text: "Condition for lines without one" }, prefSelect),
        el("label", { for: "yyt-card-list", text: "Card IDs and quantities" }, input),
        errorBox,
        el("div", { className: "actions" }, resolveButton)
      );
      input.focus();
    }
    async function showResolving(parsed, source, conditionPreference = "prefer-normal") {
      lookupController = new AbortController();
      const message = el("p", { text: `Resolving ${parsed.requests.length} distinct card requests\u2026` });
      const cancel = el("button", { type: "button", text: "Cancel", onClick: () => {
        lookupController.abort();
        showInput(source, conditionPreference);
      } });
      setView(el("h3", { text: "Resolving" }), message, el("progress", { className: "progress" }), el("div", { className: "actions" }, cancel));
      try {
        const rows = await resolve(parsed.requests, {
          signal: lookupController.signal,
          conditionPreference,
          onProgress: (text) => {
            message.textContent = text;
          }
        });
        const invalidRows = (parsed.invalid || parsed.errors || []).map((item) => ({
          ...item,
          status: "invalid",
          requestedId: item.original || "\u2014",
          requestedQuantity: 0,
          plannedQuantity: 0
        }));
        showReview([...rows, ...invalidRows], source, conditionPreference);
      } catch (error) {
        if (error.name === "AbortError" || error.cause?.name === "AbortError") return;
        setView(
          el("h3", { text: "Lookup stopped" }),
          el("div", { className: "error", text: error.message || "Unable to resolve cards." }),
          el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) }))
        );
      }
    }
    function showReview(rows, source, conditionPreference = "prefer-normal") {
      const isRowSelectable = (r) => (r.status === "ready" || r.status === "partial" || r.status === "option") && (r.stock ?? r.availableStock ?? 0) > 0;
      for (const row of rows) {
        if (typeof row.selected !== "boolean") {
          row.selected = isRowSelectable(row) && row.plannedQuantity > 0;
        }
      }
      const tbody = el("tbody");
      const countText = el("strong");
      const overWarning = el("div", { className: "warning", hidden: true });
      const rowElements = /* @__PURE__ */ new Map();
      const totalText = el("span");
      const submit = el("button", { className: "primary", type: "button" });
      const update = () => {
        const chosen = rows.filter((r) => r.selected && r.plannedQuantity > 0);
        const totalCards = chosen.reduce((n, r) => n + r.plannedQuantity, 0);
        const normalCards = chosen.filter((r) => r.condition !== "damaged").reduce((n, r) => n + r.plannedQuantity, 0);
        const damagedCards = chosen.filter((r) => r.condition === "damaged").reduce((n, r) => n + r.plannedQuantity, 0);
        const total = chosen.reduce((n, r) => n + (r.priceYen || 0) * r.plannedQuantity, 0);
        const productCount = new Set(chosen.map((r) => r.product ? [r.product.ver, r.product.cid, r.product.kizu].join("|") : r)).size;
        let desc = `${productCount} product${productCount === 1 ? "" : "s"} / ${totalCards} card${totalCards === 1 ? "" : "s"}`;
        if (damagedCards > 0 && normalCards > 0) {
          desc += ` (${normalCards} normal, ${damagedCards} damaged)`;
        } else if (damagedCards > 0) {
          desc += ` (all ${damagedCards} damaged)`;
        }
        countText.textContent = desc;
        const byRequest = /* @__PURE__ */ new Map();
        for (const r of rows) {
          if (!Number.isInteger(r.inputIndex)) continue;
          if (!byRequest.has(r.inputIndex)) byRequest.set(r.inputIndex, []);
          byRequest.get(r.inputIndex).push(r);
        }
        const over = [];
        for (const group of byRequest.values()) {
          const adding2 = group.filter((r) => r.selected).reduce((n, r) => n + (r.plannedQuantity || 0), 0);
          const requested = group[0].requestedQuantity || 0;
          const isOver = group.length > 1 && adding2 > requested;
          for (const r of group) rowElements.get(r)?.classList.toggle("over", isOver);
          if (isOver) over.push(`${group[0].requestedId || group[0].originalId}: adding ${adding2}, requested ${requested}`);
        }
        const byProduct = /* @__PURE__ */ new Map();
        for (const r of rows) {
          const key = r.product ? [r.product.ver, r.product.cid, r.product.kizu].join("|") : null;
          if (!key) continue;
          if (!byProduct.has(key)) byProduct.set(key, []);
          byProduct.get(key).push(r);
        }
        const overStock = [];
        for (const group of byProduct.values()) {
          const adding2 = group.filter((r) => r.selected).reduce((n, r) => n + (r.plannedQuantity || 0), 0);
          const stock = group[0].stock ?? group[0].availableStock ?? 0;
          const isOver = group.length > 1 && adding2 > stock;
          for (const r of group) if (isOver) rowElements.get(r)?.classList.add("over");
          if (isOver) overStock.push(`${group[0].printedId} (${group[0].condition}): adding ${adding2} across lines, ${stock} in stock`);
        }
        const messages = [
          over.length ? `More copies than requested:
${over.join("\n")}` : "",
          overStock.length ? `More than YYT has in stock:
${overStock.join("\n")}` : ""
        ].filter(Boolean);
        overWarning.hidden = !messages.length;
        overWarning.textContent = messages.join("\n\n");
        totalText.textContent = `Estimated selected total: ${yen.format(total)}`;
        submit.textContent = `Add ${totalCards} card${totalCards === 1 ? "" : "s"} from ${productCount} product${productCount === 1 ? "" : "s"}`;
        submit.disabled = !chosen.length;
      };
      for (const row of rows) {
        const stock = row.stock ?? row.availableStock ?? 0;
        const selectable = isRowSelectable(row);
        const checkbox = el("input", {
          type: "checkbox",
          "aria-label": `Select ${row.requestedId || row.printedId || "card"}`
        });
        checkbox.checked = Boolean(row.selected && row.plannedQuantity > 0);
        checkbox.disabled = !selectable;
        let addingCell;
        if (selectable) {
          const qtyInput = el("input", {
            type: "number",
            className: "qty-input",
            min: 0,
            max: stock,
            value: String(row.plannedQuantity ?? 0),
            "aria-label": `Quantity for ${row.printedId || row.requestedId}`
          });
          qtyInput.addEventListener("input", () => {
            let val = parseInt(qtyInput.value, 10);
            if (isNaN(val) || val < 0) val = 0;
            if (val > stock) val = stock;
            row.plannedQuantity = val;
            row.selected = val > 0;
            checkbox.checked = row.selected;
            update();
          });
          checkbox.addEventListener("change", () => {
            row.selected = checkbox.checked;
            if (row.selected && row.plannedQuantity === 0) {
              row.plannedQuantity = Math.min(row.requestedQuantity || 1, stock);
              qtyInput.value = String(row.plannedQuantity);
            } else if (!row.selected) {
              row.plannedQuantity = 0;
              qtyInput.value = "0";
            }
            update();
          });
          addingCell = el("td", { className: "num" }, qtyInput);
        } else {
          checkbox.addEventListener("change", () => {
            row.selected = checkbox.checked;
            update();
          });
          addingCell = el("td", { className: "num", text: "0" });
        }
        const condBadge = row.condition ? el("span", {
          className: `badge badge-${row.condition}`,
          text: row.condition === "damaged" ? "Damaged" : "Normal"
        }) : el("span", { text: "\u2014" });
        const isOption = row.status === "option";
        const tr = el(
          "tr",
          { className: [row.status === "partial" ? "partial" : selectable ? "" : "unavailable", isOption ? "alt" : ""].filter(Boolean).join(" ") },
          el("td", {}, checkbox),
          el("td", { text: row.requestedId || row.originalIds?.[0] || "\u2014" }),
          el("td", { text: row.printedId || "\u2014" }),
          el("td", { className: "rarity", text: row.rarity ? `${isOption ? "\u21B3 " : ""}${row.rarity}` : "\u2014" }),
          el("td", {}, condBadge),
          el("td", { text: row.name || "\u2014" }),
          el("td", { className: "num", text: Number.isFinite(row.priceYen) ? yen.format(row.priceYen) : "\u2014" }),
          // The requested quantity belongs to the primary row; repeating it on
          // another-rarity rows would read as a second request.
          el("td", { className: "num", text: isOption ? "\u2014" : String(row.requestedQuantity || "\u2014") }),
          el("td", { className: "num", text: Number.isFinite(stock) ? String(stock) : "\u2014" }),
          addingCell,
          el("td", { className: "status", text: statusReason(row) })
        );
        rowElements.set(row, tr);
        tbody.append(tr);
      }
      const table = el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...["Use", "Requested ID", "YYT ID", "Rarity", "Cond.", "Name", "Price", "Requested", "Stock", "Adding", "Status"].map((x) => el("th", { text: x })))),
        tbody
      );
      submit.addEventListener("click", async () => {
        if (adding) return;
        const chosen = rows.filter((r) => r.selected && r.plannedQuantity > 0);
        if (chosen.length) await runBatch(rows, chosen, source, conditionPreference);
      });
      update();
      setView(
        el("h3", { text: "Review matches & allocate quantities" }),
        el("p", { className: "warning", text: "Quantities will be added to the existing cart. Adjust quantities across conditions and rarities as desired." }),
        el("div", { className: "table-wrap" }, table),
        overWarning,
        el("div", { className: "summary" }, countText, totalText),
        el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) }), submit)
      );
      submit.focus();
    }
    async function runBatch(allRows, chosen, source, conditionPreference) {
      adding = true;
      cancelRequested = false;
      addController = new AbortController();
      const results = [];
      const current = el("p", { text: "Preparing\u2026" });
      const progress = el("progress", { className: "progress", max: chosen.length, value: 0 });
      const cancel = el("button", { className: "danger", type: "button", text: "Cancel before next item" });
      cancel.addEventListener("click", () => {
        cancelRequested = true;
        cancel.disabled = true;
        current.textContent = "Cancellation requested; finishing the current request\u2026";
      });
      setView(
        el("h3", { text: "Adding products one at a time" }),
        current,
        progress,
        el("p", { className: "hint", text: "Cancel affects only products not yet started. It cannot undo additions already completed." }),
        el("div", { className: "actions" }, cancel)
      );
      let token;
      try {
        token = await getCsrfToken2({ signal: addController.signal });
      } catch (error) {
        adding = false;
        showResults(allRows, chosen, [{ outcome: "failed", message: error.message || "Could not obtain a CSRF token." }], source, conditionPreference);
        return;
      }
      for (let index = 0; index < chosen.length; index += 1) {
        const row = chosen[index];
        if (cancelRequested) {
          for (const pending of chosen.slice(index)) results.push({ row: pending, outcome: "skipped", message: "Cancelled before request" });
          break;
        }
        current.textContent = `Adding ${row.printedId}${row.rarity ? ` ${row.rarity}` : ""} (${index + 1} of ${chosen.length})\u2026`;
        let result;
        try {
          result = await addItem(row, token, { signal: addController.signal });
        } catch (error) {
          result = { outcome: "unknown", message: error.message || "Response was lost; inspect the cart before retrying." };
        }
        results.push({ row, ...result });
        progress.value = index + 1;
        if (result.stopBatch || result.outcome === "unknown") {
          for (const pending of chosen.slice(index + 1)) results.push({ row: pending, outcome: "skipped", message: "Batch stopped before request" });
          break;
        }
        if (result.outcome === "success" && index < chosen.length - 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, mutationDelayMs));
      }
      adding = false;
      showResults(allRows, chosen, results, source, conditionPreference);
    }
    function showResults(allRows, chosen, results, source, conditionPreference) {
      const selected = new Set(chosen);
      const skippedReview = allRows.filter((r) => !selected.has(r)).map((row) => ({ row, outcome: "skipped", message: statusReason(row) }));
      const combined = [...results, ...skippedReview];
      const groups = [
        ["success", "Successfully added"],
        ["skipped", "Skipped before submission"],
        ["failed", "Failed with a definite response"],
        ["unknown", "Unknown outcome"]
      ];
      const nodes = groups.map(([key, label]) => {
        const matches = combined.filter((r) => r.outcome === key);
        if (!matches.length) return null;
        const list = el("ul");
        for (const result of matches) {
          const cond = [result.row?.rarity, result.row?.condition].filter(Boolean).map((x) => ` [${x}]`).join("");
          list.append(el("li", { text: `${result.row?.printedId || result.row?.requestedId || "Batch"}${cond}: ${result.message || key}` }));
        }
        return el("section", { className: "result-group" }, el("h3", { text: `${label} (${matches.length})` }), list);
      }).filter(Boolean);
      const hasUnknown = combined.some((r) => r.outcome === "unknown");
      const report = groups.flatMap(([key, label]) => combined.filter((r) => r.outcome === key).map((r) => {
        const cond = [r.row?.rarity, r.row?.condition].filter(Boolean).map((x) => ` [${x}]`).join("");
        return `${label}: ${r.row?.printedId || r.row?.requestedId || "Batch"}${cond} \u2014 ${r.message || key}`;
      })).join("\n");
      const copy = el("button", { type: "button", text: "Copy report", onClick: async (event) => {
        try {
          await navigator.clipboard.writeText(report);
          event.currentTarget.textContent = "Copied";
        } catch {
          event.currentTarget.textContent = "Copy failed";
        }
      } });
      setView(
        el("h3", { text: "Results" }),
        hasUnknown ? el("div", { className: "error", text: "A cart request has an unknown outcome. Do not retry it until you inspect the cart." }) : null,
        ...nodes,
        el(
          "div",
          { className: "actions" },
          el("button", { type: "button", text: "Open cart", className: "primary", onClick: () => {
            location.href = "/cart/sell";
          } }),
          copy,
          el("button", { type: "button", text: "Close", onClick: close })
        )
      );
    }
    return { open, close };
  }

  // src/main.js
  function uiRow(row) {
    const product = row.product;
    return {
      ...row,
      requestedId: row.originalIds?.[0] ?? row.originalId ?? row.normalizedId,
      printedId: row.canonicalPrintedId ?? product?.printedId ?? null,
      stock: row.availableStock,
      gid: product?.gid,
      ver: product?.ver,
      cid: product?.cid,
      kizu: row.kizu ?? product?.kizu,
      condition: row.condition ?? product?.condition ?? (product?.kizu === "0" ? "normal" : "damaged"),
      limit: product?.limit
    };
  }
  mountApp({
    parse: parseInput,
    async resolve(requests, options = {}) {
      const resolved = await lookupProducts(requests, {
        signal: options.signal,
        delayMs: 250,
        conditionPreference: options.conditionPreference
      });
      return resolved.rows.map(uiRow);
    },
    getCsrfToken,
    async addItem(row, csrfToken, options = {}) {
      return addCartItem(row.product, row.plannedQuantity, {
        csrfToken,
        signal: options.signal
      });
    },
    mutationDelayMs: DEFAULT_CART_DELAY_MS
  });
})();
