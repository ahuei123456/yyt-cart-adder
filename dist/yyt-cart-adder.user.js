// ==UserScript==
// @name         YYT Weiss Schwarz Cart Adder
// @namespace    local.yyt-cart-adder
// @version      0.4.0
// @description  Resolve Weiss Schwarz card IDs and add reviewed quantities to a YYT cart.
// @homepageURL  https://github.com/ahuei123456/yyt-cart-adder
// @updateURL    https://raw.githubusercontent.com/ahuei123456/yyt-cart-adder/master/dist/yyt-cart-adder.user.js
// @downloadURL  https://raw.githubusercontent.com/ahuei123456/yyt-cart-adder/master/dist/yyt-cart-adder.user.js
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
    PRODUCT_INVALID: "PRODUCT_INVALID",
    PRODUCT_MISSING: "PRODUCT_MISSING",
    PRODUCT_RARITY_MISSING: "PRODUCT_RARITY_MISSING",
    PRODUCT_CONDITION_MISSING: "PRODUCT_CONDITION_MISSING",
    PRODUCT_VARIANT: "PRODUCT_VARIANT",
    PRODUCT_SOLD_OUT: "PRODUCT_SOLD_OUT",
    PRODUCT_PARTIAL_STOCK: "PRODUCT_PARTIAL_STOCK",
    PRODUCT_OTHER_RARITY: "PRODUCT_OTHER_RARITY",
    PRODUCT_OTHER_CONDITION: "PRODUCT_OTHER_CONDITION",
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
  function normalizePrintedId(value) {
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
  function cleanText(value) {
    return String(value ?? "").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/g, " ").trim();
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
  var RARITY_PATTERN = /^(?:(?:[A-Z]{1,2}-)?[A-Z@]{1,5}(?:\+|★{1,3})?|-)$/u;
  function normalizeRarity(value) {
    if (value == null) return null;
    const text = String(value).normalize("NFKC").trim().toLocaleUpperCase("en-US").replace(/[*☆]/gu, "\u2605");
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
      code: ERROR_CODES.PRODUCT_INVALID,
      reason: `missing or invalid ${field}`,
      field
    };
  }
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
      available: !soldOut
    };
    return { product, error: null };
  }
  function looksLikeExplicitEmptyResult(html) {
    const text = cleanText(String(html ?? ""));
    return EMPTY_RESULT_PATTERNS.some((pattern) => pattern.test(text));
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
  function readLastPage(document2) {
    let last = 1;
    for (const link of queryAll(document2, 'a[href*="page="]')) {
      const match = /[?&]page=(\d+)/u.exec(getAttribute(link, "href") ?? "");
      if (match) last = Math.max(last, Number(match[1]));
    }
    return last;
  }
  function parseSearchResults(html) {
    const source = String(html ?? "");
    const document2 = new DOMParser().parseFromString(source, "text/html");
    const cardElements = collectCardProducts(document2);
    const products = [];
    const rejected = [];
    for (const { element, sectionRarity } of cardElements) {
      const parsed = parseProductElement(element, sectionRarity);
      if (parsed.product) products.push(parsed.product);
      else rejected.push(parsed.error);
    }
    const explicitEmpty = looksLikeExplicitEmptyResult(source);
    const lastPage = readLastPage(document2);
    const structureError = cardElements.length > 0 && products.length === 0 || cardElements.length === 0 && source.trim() !== "" && !explicitEmpty;
    return {
      products,
      rejected,
      cardProductCount: cardElements.length,
      structureError,
      explicitEmpty,
      lastPage
    };
  }

  // src/core/input.js
  var INTEGER_PATTERN = /^\d+$/u;
  var CARD_TOKEN_PATTERN = /^\S+$/u;
  function makeInputError({ lineNumber, raw, message, lineNumbers = [lineNumber], normalizedId, original }) {
    return {
      code: ERROR_CODES.INPUT_INVALID,
      message,
      reason: message,
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
  var RARITY_TOKEN_PATTERN = /^(?:[A-Z]{1,2}-)?[A-Z@]{1,5}(?:\+|[★☆*]{1,3})?$/u;
  function parseRarityToken(token) {
    if (typeof token !== "string" || !RARITY_TOKEN_PATTERN.test(token)) return null;
    return normalizeRarity(token);
  }
  function parseLine(raw, lineNumber) {
    const trimmed = raw.normalize("NFKC").trim();
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
    if (extractPrintedId(originalId) !== originalId) {
      return {
        kind: "error",
        error: makeInputError({
          lineNumber,
          raw,
          original: originalId,
          normalizedId,
          message: `"${originalId}" is not a Weiss Schwarz card ID such as Kka/W102-005SEC.`
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
    return {
      requests: [...requestsById.values()],
      errors
    };
  }

  // src/core/request.js
  var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
  async function withRequestDeadline(run, options = {}) {
    const controller = new AbortController();
    const parent = options.signal;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let timer;
    const onAbort = () => controller.abort(parent.reason);
    if (parent?.aborted) onAbort();
    else parent?.addEventListener("abort", onAbort, { once: true });
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const stop = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", stop, { once: true });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
      return await Promise.race([run(controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", stop);
    }
  }
  function responseStatus(response) {
    const status = Number(response?.status);
    return Number.isInteger(status) && status > 0 ? status : null;
  }
  function responseOk(response) {
    if (typeof response?.ok === "boolean") return response.ok;
    const status = responseStatus(response);
    return status !== null && status >= 200 && status < 300;
  }
  function wait(milliseconds, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  function notify(callback, value) {
    if (typeof callback !== "function") return;
    try {
      callback(value);
    } catch {
    }
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
    return String(value.originalId ?? value.originalIds?.[0] ?? "").trim();
  }
  function makeRequest(value, index) {
    const fields = typeof value === "string" ? { originalIds: [value] } : value;
    const originalIds = (fields.originalIds ?? [fields.originalId]).map((id) => String(id).trim());
    const rarity = normalizeRarity(fields.rarity);
    return {
      originalId: originalIds[0],
      originalIds,
      normalizedId: fields.normalizedId ?? normalizePrintedId(originalIds[0]),
      ...fields.condition ? { condition: fields.condition } : {},
      ...rarity ? { rarity } : {},
      requestedQuantity: fields.requestedQuantity ?? 1,
      sourceLines: fields.sourceLines ?? [],
      inputIndex: index
    };
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
      const canonical = normalizePrintedId(prefix);
      const key = canonicalKeys.get(canonical) ?? prefix;
      canonicalKeys.set(canonical, key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    }
    return groups;
  }
  function buildLookupPlan(values) {
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
      "No fetch implementation is available for YYT search"
    );
  }
  function getOrigin(options) {
    if (options.origin) return String(options.origin);
    if (typeof globalThis !== "undefined" && globalThis.location?.origin) {
      return globalThis.location.origin;
    }
    return "https://yuyu-tei.jp";
  }
  function makeSearchUrl(query, options, { condition = "normal", page = 1 } = {}) {
    const url = new URL("/sell/ws/s/search", getOrigin(options));
    url.searchParams.set("search_word", query);
    if (condition === "damaged") url.searchParams.set("kizu", "1");
    if (page > 1) url.searchParams.set("page", String(page));
    return url.toString();
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
    await wait(milliseconds, options.signal);
    if (options.signal?.aborted) throw new DOMException("The lookup was cancelled", "AbortError");
  }
  function isAbortError(error) {
    return error?.name === "AbortError" || error?.code === "ABORT_ERR";
  }
  async function fetchSearchPage(query, options = {}, page = {}) {
    const fetchFunction = getFetch(options);
    const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
    const retryBaseMs = Number.isFinite(options.retryBaseMs) ? Math.max(0, options.retryBaseMs) : 250;
    const url = makeSearchUrl(String(query), options, page);
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
            signal
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
      return { query: String(query), url, status, html, response };
    }
  }
  function matchingProducts(products, normalizedIds) {
    const byId = /* @__PURE__ */ new Map();
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
      stock: availableStock
    };
  }
  function unresolvedRow(request, status, reason, extra = {}) {
    return {
      ...request,
      status,
      reason,
      printedId: null,
      product: null,
      name: "",
      priceYen: null,
      stock: 0,
      plannedQuantity: 0,
      selected: false,
      candidates: [],
      condition: request.condition ?? null,
      ...extra
    };
  }
  function makeMissingRow(request, reason = ERROR_CODES.PRODUCT_MISSING) {
    return unresolvedRow(request, "missing", reason);
  }
  function makeErrorRow(request, error) {
    return unresolvedRow(request, "error", error.code, { errorMessage: error.message });
  }
  function buildRow(request, product, plannedQuantity, stock, statusOverride = null) {
    const soldOut = Boolean(product.soldOut) || stock <= 0;
    const status = statusOverride ? statusOverride : soldOut ? "sold-out" : plannedQuantity < request.requestedQuantity ? "partial" : "ready";
    return {
      ...request,
      status,
      reason: status === "ready" ? null : status === "partial" ? ERROR_CODES.PRODUCT_PARTIAL_STOCK : ERROR_CODES.PRODUCT_SOLD_OUT,
      printedId: product.printedId,
      rarity: product.rarity ?? null,
      condition: product.condition || (product.kizu === "0" ? "normal" : "damaged"),
      kizu: product.kizu,
      product,
      name: product.name ?? "",
      priceYen: product.priceYen ?? null,
      stock,
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
      reason: row.status === "sold-out" ? ERROR_CODES.PRODUCT_SOLD_OUT : reason,
      plannedQuantity: 0,
      selected: false,
      isOption: true
    };
  }
  function makeVariantRows(request, candidates) {
    return candidates.map((product) => ({
      ...asOption(buildRow(request, product, 0, numbersForProduct(product).stock), ERROR_CODES.PRODUCT_VARIANT),
      variantCount: candidates.length
    }));
  }
  function otherConditionRows(request, candidates) {
    return candidates.map((product) => asOption(buildRow(request, product, 0, numbersForProduct(product).stock), ERROR_CODES.PRODUCT_OTHER_CONDITION));
  }
  function strictCondition(request, options) {
    const preference = options.conditionPreference || "prefer-normal";
    return request.condition ?? (preference === "normal-only" ? "normal" : preference === "damaged-only" ? "damaged" : null);
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
    if (groups.some((group) => group.rarity == null)) return makeVariantRows(request, exact);
    const rowsByGroup = groups.map((group) => makeConditionRows(request, group.products, options));
    const primaryIndex = Math.max(0, rowsByGroup.findIndex((rows) => rows.some(isResolvedRow)));
    const rarities = groups.map((group) => group.rarity);
    return rowsByGroup.flatMap(
      (rows, index) => rows.filter((row) => index === primaryIndex || row.status !== "missing").map((row) => ({
        ...index === primaryIndex ? row : asOption(row, ERROR_CODES.PRODUCT_OTHER_RARITY),
        otherRarities: rarities.filter((rarity) => rarity !== groups[index].rarity)
      }))
    );
  }
  function makeConditionRows(request, exact, options) {
    const normal = exact.filter((c) => String(c.kizu).trim() === "0");
    const damaged = exact.filter((c) => String(c.kizu).trim() !== "0");
    const preference = options.conditionPreference || "prefer-normal";
    const strict = strictCondition(request, options);
    if (strict) {
      const [wanted, other] = strict === "normal" ? [normal, damaged] : [damaged, normal];
      const primary = wanted.length > 1 ? makeVariantRows(request, wanted) : wanted.length ? [makeSingleRow(request, wanted[0], request.requestedQuantity)] : [{ ...makeMissingRow(request, ERROR_CODES.PRODUCT_CONDITION_MISSING), condition: strict }];
      return [...primary, ...otherConditionRows(request, other)];
    }
    if (normal.length > 1 || damaged.length > 1) {
      return makeVariantRows(request, exact);
    }
    if (normal.length === 1 && damaged.length === 0) {
      return [makeSingleRow(request, normal[0], request.requestedQuantity)];
    }
    if (damaged.length === 1 && normal.length === 0) {
      return [makeSingleRow(request, damaged[0], request.requestedQuantity)];
    }
    if (normal.length === 1 && damaged.length === 1) {
      const [first, second] = preference === "prefer-damaged" ? [damaged[0], normal[0]] : [normal[0], damaged[0]];
      const firstStock = numbersForProduct(first).stock;
      const secondStock = numbersForProduct(second).stock;
      const firstPlanned = Math.min(request.requestedQuantity, firstStock);
      const secondPlanned = Math.min(request.requestedQuantity - firstPlanned, secondStock);
      const short = firstPlanned + secondPlanned < request.requestedQuantity;
      const status = (stock) => stock <= 0 ? "sold-out" : short ? "partial" : "ready";
      const firstRow = buildRow(request, first, firstPlanned, firstStock, status(firstStock));
      const secondRow = buildRow(request, second, secondPlanned, secondStock, status(secondStock));
      return [firstRow, secondPlanned > 0 ? secondRow : asOption(secondRow, ERROR_CODES.PRODUCT_OTHER_CONDITION)];
    }
    return [makeMissingRow(request)];
  }
  async function delayBetweenQueries(options, queryNumber) {
    const delay = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 250;
    if (queryNumber > 0) await sleep(delay, options);
  }
  var MAX_PAGES = 10;
  var CONDITIONS = ["normal", "damaged"];
  function hasCandidate(candidatesById, normalizedId, condition) {
    return (candidatesById.get(normalizedId) ?? []).some((product) => product.condition === condition);
  }
  function blockingFailure(request, candidatesById, failures, options) {
    const failed = (condition) => failures.get(`${request.normalizedId}|${condition}`);
    const strict = strictCondition(request, options);
    if (strict) return hasCandidate(candidatesById, request.normalizedId, strict) ? null : failed(strict) ?? null;
    if (candidatesById.has(request.normalizedId)) return null;
    return failed("normal") ?? failed("damaged") ?? null;
  }
  function queryExpectedIds(values) {
    return new Set(values.map((value) => normalizePrintedId(requestId(value))).filter(Boolean));
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
    const normalizedRequests = requests.map(makeRequest);
    const expectedIds = new Set(normalizedRequests.map((request) => request.normalizedId));
    const candidatesById = /* @__PURE__ */ new Map();
    const failures = /* @__PURE__ */ new Map();
    const queries = [];
    const { groups, fallbackIds } = buildLookupPlan(normalizedRequests);
    let queryNumber = 0;
    const runQuery = async (type, query, queryIds, condition, progress) => {
      notify(options.onProgress, { type, query, condition, ...progress });
      let lastPage = 1;
      try {
        for (let page = 1; page <= lastPage; page += 1) {
          await delayBetweenQueries(options, queryNumber);
          queryNumber += 1;
          const result = await fetchSearchPage(query, options, { condition, page });
          const parsed = parseSearchResults(result.html);
          assertStructure(parsed, query, queryIds);
          mergeCandidates(candidatesById, matchingProducts(parsed.products, expectedIds));
          queries.push({
            type,
            query,
            condition,
            page,
            url: result.url,
            status: result.status,
            cardProductCount: parsed.cardProductCount,
            productCount: parsed.products.length
          });
          if (page === 1) lastPage = Math.min(Math.max(1, parsed.lastPage ?? 1), MAX_PAGES);
        }
      } catch (error) {
        if (options.signal?.aborted || !(error instanceof LookupError)) throw error;
        for (const id of queryIds) {
          if (!hasCandidate(candidatesById, id, condition)) failures.set(`${id}|${condition}`, error);
        }
        queries.push({ type, query, condition, url: error.url ?? null, status: error.status ?? null, error: error.code });
      }
    };
    const prefixSearches = [...groups].flatMap(([prefix, values]) => CONDITIONS.map((condition) => ({ prefix, ids: queryExpectedIds(values), condition })));
    for (const [index, { prefix, ids, condition }] of prefixSearches.entries()) {
      await runQuery("prefix", prefix, ids, condition, { index, total: prefixSearches.length });
    }
    const exactSearches = [];
    const exactSeen = /* @__PURE__ */ new Set();
    const addExact = (request, condition) => {
      const key = `${request.normalizedId}|${condition}`;
      if (exactSeen.has(key)) return;
      exactSeen.add(key);
      exactSearches.push({ request, condition });
    };
    for (const request of fallbackIds) CONDITIONS.forEach((condition) => addExact(request, condition));
    for (const request of normalizedRequests) {
      if (!candidatesById.has(request.normalizedId) && !failures.has(`${request.normalizedId}|normal`)) {
        addExact(request, "normal");
      }
    }
    for (const [index, { request, condition }] of exactSearches.entries()) {
      await runQuery("exact", request.originalId, /* @__PURE__ */ new Set([request.normalizedId]), condition, {
        index,
        total: exactSearches.length
      });
    }
    const rows = dropDuplicateOptions(
      normalizedRequests.flatMap((request) => {
        const failure = blockingFailure(request, candidatesById, failures, options);
        return failure ? [makeErrorRow(request, failure)] : makeRows(request, candidatesById.get(request.normalizedId), options);
      })
    );
    return {
      rows,
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
  var CartError = class extends YytError {
    constructor(code, message, details = {}) {
      super(code, message);
      this.name = "CartError";
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
    return options.fetch ?? defaultFetch();
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
  function extractCsrfTokenFromHtml(html) {
    if (typeof html !== "string" || typeof DOMParser === "undefined") {
      return null;
    }
    return extractCsrfToken(new DOMParser().parseFromString(html, "text/html"));
  }
  async function getCsrfToken(options = {}) {
    try {
      return await withRequestDeadline((signal) => loadCsrfToken({ ...options, signal }), options);
    } catch (error) {
      if (error instanceof CartError) throw error;
      throw new CartError(CART_ERROR_CODES.CSRF_MISSING, "The CSRF token could not be loaded. Nothing was added to the cart.", { cause: error });
    }
  }
  async function loadCsrfToken(options) {
    const documentRef = options.documentRef ?? defaultDocument();
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
    const responseStatus2 = responseStatus(response);
    if (!responseOk(response)) {
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
    const token = extractCsrfTokenFromHtml(String(html));
    if (!token) {
      throw new CartError(
        CART_ERROR_CODES.CSRF_MISSING,
        "The page did not expose a usable CSRF token. Nothing was added to the cart.",
        { responseStatus: responseStatus2 }
      );
    }
    return token;
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
    const responseStatus2 = responseStatus(response);
    if (responseStatus2 >= 500) return unknownResult(item, attemptedQuantity, responseStatus2);
    let text;
    try {
      text = await response.text();
    } catch {
      if (!responseOk(response)) {
        const classification2 = classifyHttpFailure(responseStatus2, null, false);
        return {
          ...resultBase(item, attemptedQuantity),
          outcome: "failed",
          message: classification2.message,
          responseStatus: responseStatus2,
          code: classification2.code,
          stopBatch: classification2.stopBatch
        };
      }
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "unknown",
        message: "The cart response was interrupted; inspect /cart/sell before retrying.",
        responseStatus: responseStatus2,
        code: CART_ERROR_CODES.CART_OUTCOME_UNKNOWN,
        stopBatch: true
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(String(text).replace(/^\uFEFF/u, ""));
    } catch {
      if (responseOk(response)) return unknownResult(item, attemptedQuantity, responseStatus2);
      const code = classifyHttpFailure(responseStatus2, null, false).code;
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "failed",
        message: "YYT rejected this cart item with an unreadable response.",
        responseStatus: responseStatus2,
        code,
        stopBatch: true
      };
    }
    if (responseOk(response) && parsed?.status === CART_SUCCESS_STATUS) {
      return {
        ...resultBase(item, attemptedQuantity),
        outcome: "success",
        message: `Added ${attemptedQuantity}`,
        responseStatus: responseStatus2,
        code: null,
        stopBatch: false
      };
    }
    if (responseOk(response) && (!parsed || typeof parsed.status !== "string" || !parsed.status.trim())) {
      return unknownResult(item, attemptedQuantity, responseStatus2);
    }
    const classification = classifyHttpFailure(responseStatus2, parsed, responseOk(response));
    return {
      ...resultBase(item, attemptedQuantity),
      outcome: "failed",
      message: classification.message,
      responseStatus: responseStatus2,
      code: classification.code,
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
    for (const field of ["stock", "limit", "cartActive", "cartLimit"]) {
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
        `This product is no longer available in ${String(product.kizu ?? "0") === "0" ? "normal" : "damaged"} condition.`
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
  function buildCartRequest(product, plannedQuantity, csrfToken, config = {}) {
    validateProduct(product);
    const quantity = prepareQuantity(product, plannedQuantity);
    const token = cleanToken(csrfToken);
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
      stopBatch: true
    };
  }
  function localValidationResult(item, error) {
    const code = error?.code ?? CART_ERROR_CODES.CART_REJECTED;
    const message = error?.message ?? "This item could not be added.";
    return skippedResult(item, code, message);
  }
  async function addCartItem(productOrItem, plannedQuantity, options = {}) {
    const item = productOrItem?.product ? productOrItem : { product: productOrItem };
    const product = item.product ?? {};
    const signal = options.signal;
    if (signal?.aborted) {
      return skippedResult(item, CART_ERROR_CODES.CANCELLED, "Cancelled before the cart request was sent.");
    }
    let request;
    try {
      request = buildCartRequest(product, plannedQuantity, options.csrfToken, {
        now: options.now,
        url: options.url,
        signal
      });
    } catch (error) {
      return localValidationResult(item, error);
    }
    const fetchImpl = getFetchImplementation(options);
    if (typeof fetchImpl !== "function") {
      return unknownResult(item, request.quantity);
    }
    try {
      const { quantity: _quantity, ...requestInit } = request;
      return await withRequestDeadline(async (requestSignal) => {
        const response = await fetchImpl(request.url, { ...requestInit, signal: requestSignal });
        return parseCartResponse(response, item, request.quantity);
      }, options);
    } catch {
      return unknownResult(item, request.quantity);
    }
  }
  function isCancelled(options) {
    return Boolean(options.signal?.aborted || options.cancelSignal?.aborted);
  }
  function skippedAfterStop(item, code, message) {
    return skippedResult(item, code ?? CART_ERROR_CODES.CART_REJECTED, message);
  }
  async function addCartItems(items, options = {}) {
    const list = Array.from(items ?? []);
    const results = [];
    if (list.length === 0) {
      return {
        results,
        stopped: false,
        cancelled: false,
        stopCode: null,
        stopMessage: null,
        processedCount: 0,
        successfulCount: 0
      };
    }
    if (isCancelled(options)) {
      const stopCode2 = CART_ERROR_CODES.CANCELLED;
      const stopMessage2 = "Cancelled before the CSRF token was loaded.";
      for (const item of list) {
        results.push(skippedAfterStop(item, stopCode2, stopMessage2));
      }
      return {
        results,
        stopped: true,
        cancelled: true,
        stopCode: stopCode2,
        stopMessage: stopMessage2,
        processedCount: 0,
        successfulCount: 0
      };
    }
    let csrfToken = cleanToken(options.csrfToken);
    if (!csrfToken) {
      try {
        csrfToken = await getCsrfToken(options);
      } catch (error) {
        const code = error?.code ?? CART_ERROR_CODES.CSRF_MISSING;
        const message = error?.message ?? "A CSRF token could not be obtained.";
        for (const item of list) {
          results.push(skippedAfterStop(item, code, message));
        }
        return {
          results,
          stopped: true,
          cancelled: false,
          stopCode: code,
          stopMessage: message,
          processedCount: 0,
          successfulCount: 0
        };
      }
    }
    const delayMs = options.delayMs ?? DEFAULT_CART_DELAY_MS;
    const sleep2 = options.sleep ?? ((milliseconds) => wait(milliseconds, options.cancelSignal));
    let stopped = false;
    let cancelled = false;
    let stopCode = null;
    let stopMessage = null;
    let successfulCount = 0;
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (isCancelled(options)) {
        cancelled = true;
        stopped = true;
        stopCode = CART_ERROR_CODES.CANCELLED;
        stopMessage = "Cancelled before the next cart request.";
        for (let remaining = index; remaining < list.length; remaining += 1) {
          results.push(skippedAfterStop(list[remaining], stopCode, stopMessage));
        }
        break;
      }
      const result = await addCartItem(item, item?.plannedQuantity, {
        ...options,
        csrfToken
      });
      results.push(result);
      notify(options.onProgress, {
        index,
        total: list.length,
        item,
        result,
        completedCount: index + 1
      });
      if (result.outcome === "success") {
        successfulCount += 1;
        if (index < list.length - 1 && !isCancelled(options) && delayMs > 0) {
          try {
            await sleep2(delayMs);
          } catch {
          }
        }
        continue;
      }
      if (result.outcome === "skipped" && result.code === CART_ERROR_CODES.CANCELLED) {
        cancelled = true;
        stopped = true;
        stopCode = result.code;
        stopMessage = result.message;
        for (let remaining = index + 1; remaining < list.length; remaining += 1) {
          results.push(skippedAfterStop(list[remaining], stopCode, stopMessage));
        }
        break;
      }
      if (result.outcome === "unknown" || result.stopBatch) {
        stopped = true;
        stopCode = result.code ?? CART_ERROR_CODES.CART_OUTCOME_UNKNOWN;
        stopMessage = result.message;
        for (let remaining = index + 1; remaining < list.length; remaining += 1) {
          results.push(skippedAfterStop(list[remaining], stopCode, "Not attempted because the batch was stopped after the previous cart result."));
        }
        break;
      }
    }
    return {
      results,
      stopped,
      cancelled,
      stopCode,
      stopMessage,
      processedCount: results.filter((result) => result.outcome !== "skipped").length,
      successfulCount
    };
  }

  // src/ui/review.js
  var MAX_COPIES = 99;
  function isSelectable(row) {
    return ["ready", "partial", "option"].includes(row.status) && (row.stock ?? 0) > 0;
  }
  function chosenRows(rows) {
    return rows.filter((row) => row.selected && row.plannedQuantity > 0);
  }
  function groupBy(rows, keyOf) {
    const groups = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.values()];
  }
  var adding = (rows) => rows.filter((row) => row.selected).reduce((n, row) => n + (row.plannedQuantity || 0), 0);
  function summarizeReview(rows) {
    const chosen = chosenRows(rows);
    const cards = (list) => list.reduce((n, row) => n + row.plannedQuantity, 0);
    const totalCards = cards(chosen);
    const damagedCards = cards(chosen.filter((row) => row.condition === "damaged"));
    const overRequested = groupBy(rows, (row) => Number.isInteger(row.inputIndex) ? row.inputIndex : null).map((group) => ({ rows: group, adding: adding(group), requested: group[0].requestedQuantity || 0 })).filter((group) => group.rows.length > 1 && group.adding > group.requested);
    const overStock = groupBy(rows, (row) => productKey(row.product)).map((group) => ({ rows: group, adding: adding(group), max: Math.min(MAX_COPIES, ...group.map((row) => row.stock ?? 0)) })).filter((group) => group.rows.length > 1 && group.adding > group.max);
    return {
      chosen,
      totalCards,
      damagedCards,
      normalCards: totalCards - damagedCards,
      totalYen: chosen.reduce((n, row) => n + (row.priceYen || 0) * row.plannedQuantity, 0),
      productCount: new Set(chosen.map((row) => productKey(row.product) ?? row)).size,
      overRequested,
      overStock
    };
  }
  function mergeByProduct(chosen) {
    const byProduct = /* @__PURE__ */ new Map();
    for (const row of chosen) {
      const key = productKey(row.product) ?? row;
      const merged = byProduct.get(key);
      if (merged) merged.plannedQuantity += row.plannedQuantity;
      else byProduct.set(key, { ...row });
    }
    return [...byProduct.values()];
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
      option: row.reason === ERROR_CODES.PRODUCT_OTHER_CONDITION ? `${cond === "damaged" ? "Damaged" : "Normal"} copy; set a quantity to add` : row.reason === ERROR_CODES.PRODUCT_VARIANT ? `One of ${row.variantCount} versions of this ID (see name); requested ${row.requestedQuantity}, set quantities to add` : `Same ID in another rarity${also}; set a quantity to add`,
      partial: `Requested ${row.requestedQuantity}; adding ${row.plannedQuantity}`,
      "sold-out": `Card is sold out in ${cond} condition`,
      missing: row.reason === ERROR_CODES.PRODUCT_RARITY_MISSING ? `No ${row.rarity} product for this ID` : row.reason === ERROR_CODES.PRODUCT_CONDITION_MISSING ? `No ${cond} copy for this ID` : "No exact card found",
      error: row.reason === ERROR_CODES.LOOKUP_SITE_CHANGED ? "YYT's search page could not be read; skipped" : `Search failed (${row.errorMessage || row.reason}); skipped`,
      invalid: row.reason || "Invalid input"
    };
    return messages[row.status] || row.reason || row.status;
  }
  function mountApp({ parse, resolve, addItems }) {
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
    let adding2 = false;
    let showingResults = false;
    let resultsUnseen = false;
    const setView = (...nodes) => {
      showingResults = false;
      body.replaceChildren(el("div", { className: "view" }, ...nodes));
    };
    const close = () => {
      lookupController?.abort();
      backdrop.hidden = true;
      previousFocus?.focus?.();
    };
    const open = () => {
      previousFocus = document.activeElement;
      backdrop.hidden = false;
      if (!body.firstChild || showingResults && !resultsUnseen) showInput();
      else body.querySelector("textarea, button.primary")?.focus();
      resultsUnseen = false;
    };
    launcher.addEventListener("click", open);
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && !backdrop.hidden) {
        const focusable = [...panel.querySelectorAll("button:not(:disabled), textarea, select:not(:disabled), input:not(:disabled), a[href]")];
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
          const errList = parsed.errors;
          errorBox.hidden = false;
          errorBox.textContent = errList.length ? errList.map((x) => `Line ${x.lineNumber}: ${x.reason || x.message}`).join("\n") : "Enter at least one card ID.";
          return;
        }
        await showResolving(parsed, input.value, prefSelect.value);
      });
      setView(
        el("p", { className: "warning", text: "Quantities below will be added to anything already in your cart." }),
        el("p", { className: "hint", text: "One exact printed card ID per line; quantity defaults to 1. Append 'damaged'/1 or 'normal'/0 to fix a line's condition (this overrides the setting above), and a rarity such as RR, S-RR or SR** (for SR\u2605\u2605) when an ID is sold in more than one. Lines beginning with # are ignored." }),
        el("label", { for: "yyt-condition-preference", text: "Condition for lines without one" }, prefSelect),
        el("label", { for: "yyt-card-list", text: "Card IDs and quantities" }, input),
        errorBox,
        el("div", { className: "actions" }, resolveButton)
      );
      input.focus();
    }
    async function showResolving(parsed, source, conditionPreference = "prefer-normal") {
      lookupController = new AbortController();
      const message = el("p", { role: "status", text: `Resolving ${parsed.requests.length} distinct card requests\u2026` });
      const cancel = el("button", { type: "button", text: "Cancel", onClick: () => lookupController.abort() });
      setView(el("h3", { text: "Resolving" }), message, el("progress", { className: "progress" }), el("div", { className: "actions" }, cancel));
      const { signal } = lookupController;
      try {
        const rows = await resolve(parsed.requests, {
          signal,
          conditionPreference,
          onProgress: ({ type, query, condition, index, total }) => {
            const copies = condition === "damaged" ? " damaged copies" : "";
            message.textContent = type === "exact" ? `Searching individually for ${query}${copies} (${index + 1} of ${total})\u2026` : `Searching ${query}${copies} (${index + 1} of ${total})\u2026`;
          }
        });
        const invalidRows = parsed.errors.map((item) => ({
          ...item,
          status: "invalid",
          originalId: item.original || "\u2014",
          requestedQuantity: 0,
          plannedQuantity: 0
        }));
        if (signal.aborted) showInput(source, conditionPreference);
        else showReview([...rows, ...invalidRows], source, conditionPreference);
      } catch (error) {
        if (signal.aborted) return showInput(source, conditionPreference);
        setView(
          el("h3", { text: "Lookup stopped" }),
          el("div", { className: "error", text: error.message || "Unable to resolve cards." }),
          el("div", { className: "actions" }, el("button", { type: "button", text: "Back", onClick: () => showInput(source, conditionPreference) }))
        );
      }
    }
    function showReview(rows, source, conditionPreference = "prefer-normal") {
      for (const row of rows) {
        if (typeof row.selected !== "boolean") {
          row.selected = isSelectable(row) && row.plannedQuantity > 0;
        }
      }
      const tbody = el("tbody");
      const countText = el("strong");
      const overWarning = el("div", { className: "warning", hidden: true });
      const rowElements = /* @__PURE__ */ new Map();
      const totalText = el("span");
      const submit = el("button", { className: "primary", type: "button" });
      const update = () => {
        const summary = summarizeReview(rows);
        const { totalCards, normalCards, damagedCards, productCount } = summary;
        let desc = `${productCount} product${productCount === 1 ? "" : "s"} / ${totalCards} card${totalCards === 1 ? "" : "s"}`;
        if (damagedCards > 0 && normalCards > 0) {
          desc += ` (${normalCards} normal, ${damagedCards} damaged)`;
        } else if (damagedCards > 0) {
          desc += ` (all ${damagedCards} damaged)`;
        }
        countText.textContent = desc;
        for (const tr of rowElements.values()) tr.classList.remove("over");
        for (const group of [...summary.overRequested, ...summary.overStock]) {
          for (const r of group.rows) rowElements.get(r)?.classList.add("over");
        }
        const over = summary.overRequested.map(({ rows: [first], adding: adding3, requested }) => `${first.originalId}: adding ${adding3}, requested ${requested}`);
        const overStock = summary.overStock.map(({ rows: [first], adding: adding3, max }) => `${first.printedId} (${first.condition}): adding ${adding3} across lines, maximum ${max} allowed`);
        const messages = [
          over.length ? `More copies than requested:
${over.join("\n")}` : "",
          overStock.length ? `More than YYT has in stock or the 99-copy limit; lower a quantity to continue:
${overStock.join("\n")}` : ""
        ].filter(Boolean);
        overWarning.hidden = !messages.length;
        overWarning.textContent = messages.join("\n\n");
        totalText.textContent = `Estimated selected total: ${yen.format(summary.totalYen)}`;
        submit.textContent = `Add ${totalCards} card${totalCards === 1 ? "" : "s"} from ${productCount} product${productCount === 1 ? "" : "s"}`;
        submit.disabled = !summary.chosen.length || overStock.length > 0;
      };
      for (const row of rows) {
        const stock = row.stock ?? 0;
        const quantityLimit = Math.min(stock, MAX_COPIES);
        const selectable = isSelectable(row);
        const checkbox = el("input", {
          type: "checkbox",
          "aria-label": `Select ${row.originalId || row.printedId || "card"}`
        });
        checkbox.checked = Boolean(row.selected && row.plannedQuantity > 0);
        checkbox.disabled = !selectable;
        let addingCell;
        if (selectable) {
          const qtyInput = el("input", {
            type: "number",
            className: "qty-input",
            min: 0,
            max: quantityLimit,
            value: String(row.plannedQuantity ?? 0),
            "aria-label": `Quantity for ${row.printedId || row.originalId}`
          });
          qtyInput.addEventListener("input", () => {
            let val = Number(qtyInput.value);
            if (!Number.isSafeInteger(val) || val < 0) val = 0;
            if (val > quantityLimit) val = quantityLimit;
            qtyInput.value = String(val);
            row.plannedQuantity = val;
            row.selected = val > 0;
            checkbox.checked = row.selected;
            update();
          });
          checkbox.addEventListener("change", () => {
            row.selected = checkbox.checked;
            if (row.selected && row.plannedQuantity === 0) {
              row.plannedQuantity = Math.min(row.requestedQuantity || 1, quantityLimit);
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
          el("td", { text: row.originalId || "\u2014" }),
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
        if (adding2) return;
        const { chosen } = summarizeReview(rows);
        if (chosen.length) await runBatch(rows, chosen);
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
    async function runBatch(allRows, chosen) {
      adding2 = true;
      const items = mergeByProduct(chosen);
      const cancelController = new AbortController();
      const describe = (row, index) => `Adding ${row.printedId}${row.rarity ? ` ${row.rarity}` : ""} (${index + 1} of ${items.length})\u2026`;
      const current = el("p", { role: "status", text: describe(items[0], 0) });
      const progress = el("progress", { className: "progress", max: items.length, value: 0 });
      const cancel = el("button", { className: "danger", type: "button", text: "Cancel before next item", onClick: () => {
        cancelController.abort();
        cancel.disabled = true;
        current.textContent = "Cancellation requested; finishing the current request\u2026";
      } });
      setView(
        el("h3", { text: "Adding products one at a time" }),
        current,
        progress,
        el("p", { className: "hint", text: "Cancel affects only products not yet started. It cannot undo additions already completed." }),
        el("div", { className: "actions" }, cancel)
      );
      let results;
      try {
        const batch = await addItems(items, {
          cancelSignal: cancelController.signal,
          onProgress: ({ completedCount }) => {
            progress.value = completedCount;
            if (!cancelController.signal.aborted && completedCount < items.length) {
              current.textContent = describe(items[completedCount], completedCount);
            }
          }
        });
        results = batch.results.map((result, index) => ({ row: items[index], ...result }));
      } catch (error) {
        results = [{ outcome: "unknown", message: error.message || "The batch stopped unexpectedly; inspect the cart before retrying." }];
      }
      adding2 = false;
      if (backdrop.hidden) resultsUnseen = true;
      showResults(allRows, chosen, results);
    }
    function showResults(allRows, chosen, results) {
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
          list.append(el("li", { text: `${result.row?.printedId || result.row?.originalId || "Batch"}${cond}: ${result.message || key}` }));
        }
        return el("section", { className: "result-group" }, el("h3", { text: `${label} (${matches.length})` }), list);
      }).filter(Boolean);
      const hasUnknown = combined.some((r) => r.outcome === "unknown");
      const report = groups.flatMap(([key, label]) => combined.filter((r) => r.outcome === key).map((r) => {
        const cond = [r.row?.rarity, r.row?.condition].filter(Boolean).map((x) => ` [${x}]`).join("");
        return `${label}: ${r.row?.printedId || r.row?.originalId || "Batch"}${cond} \u2014 ${r.message || key}`;
      })).join("\n");
      const copy = el("button", { type: "button", text: "Copy report", onClick: async () => {
        try {
          await navigator.clipboard.writeText(report);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Copy failed";
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
      showingResults = true;
    }
    return { open, close, root };
  }

  // src/main.js
  mountApp({
    parse: parseInput,
    async resolve(requests, { signal, conditionPreference, onProgress } = {}) {
      const { rows } = await lookupProducts(requests, { signal, conditionPreference, onProgress });
      return rows;
    },
    addItems: (items, { cancelSignal, onProgress } = {}) => addCartItems(items, { cancelSignal, onProgress })
  });
})();
