import { escape } from './escape.js';

/**
 * Markup that is safe to put in a page as it is: built by `html`, or let through by
 * `raw()`. Everything else that goes into a page is text, and is escaped.
 */
export class Html {
  constructor(readonly markup: string) {}

  toString() {
    return this.markup;
  }
}

/**
 * What can go inside `html`. Text and numbers are escaped. `Html` goes in as it is, and a
 * list goes in as each of its items in turn. Nothing, false and null leave nothing, so a
 * part that is only there sometimes can be written as `${shown && html`...`}`.
 */
export type Content = Html | string | number | false | null | undefined | readonly Content[];

/**
 * Markup, or nothing: what a parameter takes that must not be given text. An empty string
 * is allowed, since it holds nothing that could be read as markup.
 */
export type OptionalHtml = Html | '' | false | null | undefined;

const write = (content: Content): string =>
  content instanceof Html
    ? content.markup
    : Array.isArray(content)
      ? content.map(write).join('')
      : content === undefined || content === null || content === false
        ? ''
        : escape(content);

/**
 * Builds markup from a template, escaping every value put into it that is not markup
 * already. This covers element text and quoted attributes. It does not make a URL safe to
 * follow: pass an address through `safeUrl()` before it goes into `href`.
 */
export function html(strings: TemplateStringsArray, ...values: Content[]): Html {
  let markup = strings[0]!;

  for (const [index, value] of values.entries()) markup += write(value) + strings[index + 1]!;

  return new Html(markup);
}

/**
 * Markup let into a page unescaped. Only for markup this code wrote itself, such as the
 * logo, and never for anything a request or a record supplied.
 */
export const raw = (markup: string) => new Html(markup);
