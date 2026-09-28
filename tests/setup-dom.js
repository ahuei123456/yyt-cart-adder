// The core modules read HTML with the browser's DOMParser; Node has none, so
// the tests use jsdom's.  It follows the HTML spec's error recovery like a
// browser does, which YYT's damaged-copy markup needs (happy-dom drops those
// cards' fields).  The UI tests still mount on happy-dom windows.
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM().window.DOMParser;
