import css from './style.css.js';

/**
 * The one stylesheet for every page this library serves, and for the owner page of a
 * deployment that mounts it. Served as a file rather than inlined so the pages can keep a
 * content security policy with no inline styles at all, which is also why nothing here is
 * set through a style attribute.
 *
 * These pages are records: a reader arrives at one to check a claim, reads it once, and
 * leaves. So the styling does the two things that helps with, a measured column and a
 * legible hierarchy, and nothing that would make a record look like a product.
 */
export const stylesheet = css;

/**
 * A short digest of the sheet above, put in the link's query so a release that changes the
 * styling changes its address. Without that the only safe cache is no cache: a reader who
 * once loaded a page holds the sheet it came with, and the next release renders inside it.
 */
export const styleVersion = (() => {
  let hash = 0x811c9dc5;

  for (const char of stylesheet) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;

  return hash.toString(36);
})();
