import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import { raw, type Html } from './html.js';

hljs.registerLanguage('xml', xml);

/**
 * HTML source marked up with highlight.js classes, for a `<code>` block. highlight.js
 * escapes the source itself, so its output goes into the page as it is.
 */
export const highlightHtml = (source: string): Html =>
  raw(hljs.highlight(source, { language: 'xml' }).value);
