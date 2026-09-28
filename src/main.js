import { parseInput } from "./core/input.js";
import { lookupProducts } from "./core/lookup.js";
import { addCartItems } from "./core/cart.js";
import { mountApp } from "./ui/app.js";

mountApp({
  parse: parseInput,
  async resolve(requests, { signal, conditionPreference, onProgress } = {}) {
    const { rows } = await lookupProducts(requests, { signal, conditionPreference, onProgress });
    return rows;
  },
  addItems: (items, { cancelSignal, onProgress } = {}) => addCartItems(items, { cancelSignal, onProgress }),
});
