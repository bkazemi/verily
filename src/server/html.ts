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
 * One piece of a template's own text, without the line breaks and indentation it was
 * written with. Whitespace that holds a line break is dropped where it touches a tag or
 * either end of the template, or lies between two values. Anywhere else, between words or
 * between a word and a value, it becomes one space.
 *
 * `first` and `last` say whether the piece starts or ends the template; otherwise a value
 * comes before or after it.
 */
function unindent(text: string, first: boolean, last: boolean) {
  return text.replace(/\s*\n\s*/g, (run: string, at: number) => {
    const before = at === 0 ? (first ? '' : 'value') : text[at - 1];
    const after = at + run.length === text.length ? (last ? '' : 'value') : text[at + run.length];

    return before === '>' || after === '<' || !before || !after
      ? ''
      : before === 'value' && after === 'value'
        ? ''
        : ' ';
  });
}

/** Each template's text, unindented once. The same template is the same array every call. */
const unindented = new WeakMap<TemplateStringsArray, string[]>();

/**
 * Builds markup from a template, escaping every value put into it that is not markup
 * already. This covers element text and quoted attributes. It does not make a URL safe to
 * follow: pass an address through `safeUrl()` before it goes into `href`.
 *
 * The template can be written indented across lines: see `unindent` for how its line
 * breaks are taken out. Values are never changed.
 */
export function html(template: TemplateStringsArray, ...values: Content[]): Html {
  let strings = unindented.get(template);

  if (!strings) {
    strings = template.map((text, i) => unindent(text, i === 0, i === template.length - 1));
    unindented.set(template, strings);
  }

  let markup = strings[0]!;

  for (const [index, value] of values.entries()) markup += write(value) + strings[index + 1]!;

  return new Html(markup);
}

/**
 * Markup let into a page unescaped. Only for markup this code wrote itself, such as the
 * logo, and never for anything a request or a record supplied.
 */
export const raw = (markup: string) => new Html(markup);
