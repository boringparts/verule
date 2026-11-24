/* verule-ignore-next-code-line no-sync-export --
 * Exported synchronously for legacy host callers.
 */
/**
 * Formats a delivery mode.
 * @param {'alpha' | 'beta'} mode - Delivery mode.
 */
export function formatDocumented(mode) {
  return mode;
}

/**
 * Broken JSDoc attachment reference.
 * @param {string} item - Item label.
 */
/* Plain block comment between JSDoc and declaration */
export function formatBrokenAttachment(item) {
  return item;
}

export function withOxlintDirective() {
  // verule-ignore-next-code-line no-eval-like -- Allowed compatibility shim.
  // oxlint-disable-next-line no-unused-vars
  const shim = 42;
}
