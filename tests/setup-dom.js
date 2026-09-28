// The core modules read HTML with the browser's DOMParser; Node has none, so
// the tests use happy-dom's.
import { Window } from "happy-dom";

globalThis.DOMParser = new Window().DOMParser;
