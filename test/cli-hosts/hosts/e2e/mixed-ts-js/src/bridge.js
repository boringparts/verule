import { deliver } from "./sink.js";

/**
 * @param {"alpha" | "beta"} mode
 * @param {string} payload
 */
export function forwardBridge(mode, payload) {
  return deliver(mode, payload);
}
