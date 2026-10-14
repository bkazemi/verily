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
export const stylesheet = `:root {
  --ink: #23312b;
  --muted: #6b786f;
  --line: #dce2de;
  --surface: #fff;
  --raised: #f7f9f7;
  --accent: #245f43;
  --warn: #a4442b;
  color-scheme: light dark;
  accent-color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #dde5e0;
    --muted: #96a39b;
    --line: #2f3b35;
    --surface: #161a18;
    --raised: #1d2220;
    --accent: #7fc4a2;
    --warn: #e59a82;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 1rem 4rem;
  background: var(--surface);
  color: var(--ink);
  font: 16px/1.65 system-ui, -apple-system, 'Segoe UI', sans-serif;
  text-rendering: optimizeLegibility;
}

main {
  max-width: 34rem;
  margin: 0 auto;
  padding-top: 3rem;
}

/*
 * The logotype, above the page's own heading, on its own dark plate. Sized so the word is
 * the height it was without the plate, whose margin makes the box that much taller. The
 * word is white in either scheme: the plate is what it is read against, not the page.
 */
.logo {
  display: block;
  height: 2.5rem;
  margin-bottom: 1.5rem;
}

h1 {
  margin: 0 0 1.75rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line);
  font-size: 1.5rem;
  font-weight: 620;
  letter-spacing: -.02em;
  line-height: 1.25;
}

/*
 * A page holding one thing needs no rule under its heading. The rule divides a heading
 * from the record beneath it, and a page that only asks for a key has no record to divide.
 */
main.single h1 { margin-bottom: 1.25rem; padding-bottom: 0; border-bottom: none; }

/*
 * A page holding one thing sits in the middle of the window rather than at its top,
 * where it would leave most of the window empty below it.
 */
body:has(main.single) { display: flex; min-height: 100vh; min-height: 100dvh; }
main.single { width: 100%; max-width: 24rem; margin: auto; padding-bottom: 3rem; }

h2 { margin: 2rem 0 .75rem; font-size: 1.125rem; font-weight: 620; letter-spacing: -.01em; }

h3 { margin: 0 0 .5rem; font-size: 1rem; font-weight: 620; }

p { margin: 0 0 1rem; overflow-wrap: break-word; }

a { color: var(--accent); text-underline-offset: 3px; overflow-wrap: anywhere; }

a:hover { text-decoration-thickness: 2px; }

/*
 * Something to be run or published exactly as written. Its own line breaks are kept and a
 * long line is soft-wrapped rather than cut off: a soft wrap is drawn, not inserted, so
 * what is copied is still character for character what was written. Selecting inside the
 * block takes all of it, since half a command is worse than none.
 */
pre {
  position: relative;
  margin: 0 0 1rem;
  /* Room along the top line for the copy button, which sits over the block rather than in it. */
  padding: .75rem 5.25rem .75rem .875rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--raised);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: all;
}

code { font: .8125rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }

/* Made by a script, so it exists only where it works. Quiet: the block is the point. */
.copy {
  position: absolute;
  top: .5rem;
  right: .5rem;
  padding: .1875rem .5rem;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface);
  color: var(--muted);
  font: 500 .75rem/1.5 system-ui, sans-serif;
  user-select: none;
}

.copy:hover { color: var(--ink); border-color: var(--muted); }

/*
 * The two sides of the link, which is what a reader came to read. Each fact about a side
 * gets its own line: what it is, what it is called, the identifier behind that, and how it
 * was shown. Everything else on the page qualifies the pair, so it is set quieter.
 */
.side {
  margin-bottom: .75rem;
  padding: .875rem 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--raised);
}

/*
 * A subject's accounts are peers, so where there is room they sit two across. The page
 * that lists them is wider for it, and a narrow one keeps them in a single column.
 */
main:has(.accounts) { max-width: 54rem; }

.accounts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr));
  gap: .75rem;
  margin-bottom: .75rem;
}

.accounts .side { position: relative; display: flex; flex-direction: column; margin-bottom: 0; }

/* How the holder lists the account, in the card's corner and out of the lines below. */
.listing {
  position: absolute;
  top: .75rem;
  right: .875rem;
  padding: .0625rem .5rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: .6875rem;
  font-weight: 550;
}

.listing.preferred { border-color: var(--accent); color: var(--accent); }

/* The times sit at the foot of the card, so they line up along a row of uneven cards. */
.accounts .side dl { margin-top: auto; }
.accounts .side p:last-of-type { margin-bottom: .625rem; }

/* Between a subject and its accounts on the page that lists them. */
.joiner { display: block; width: 1.25rem; height: 1.25rem; margin: 0 auto .75rem; color: var(--muted); }

.who {
  margin: 0 0 .125rem;
  color: var(--muted);
  font-size: .75rem;
  font-weight: 550;
  letter-spacing: .02em;
}

/* A provider's mark before its name, at the height of the letters. */
.who .provider { display: inline-block; width: .875rem; height: .875rem; margin-right: .375rem; vertical-align: -.125rem; }

/* Clipped 4px left of the text, which hides the date's dot when the date wraps to a new line. */
.name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 1rem; margin: 0 0 0 -4px; padding-left: 4px; overflow-x: clip; font-size: 1.0625rem; font-weight: 620; letter-spacing: -.01em; }

/* The account's creation date, after the name and a dot. It wraps under a long name. */
.name .since { position: relative; color: var(--muted); font-size: .8125rem; font-weight: 400; letter-spacing: 0; white-space: nowrap; }

/* The dot sits in the gap before the date. */
.name .since::before { content: "·"; position: absolute; left: -.5rem; transform: translateX(-50%); }

/* The name is the card's subject before it is a link, so the rule is drawn on hover. */
.name a { text-decoration: none; }

.name a:hover { text-decoration: underline; }

.reference, .how { margin: 0; color: var(--muted); font-size: .8125rem; line-height: 1.5; }

.name + .how, .reference + .how { margin-top: .5rem; }
.fingerprint { font-family: ui-monospace, monospace; text-wrap: balance; }
.fingerprint span { display: inline-block; margin-right: .5ch; }
.how.additional { padding-left: .75rem; }
/* The "signed" pill after the verifier's name, one size smaller than the line it sits on. */
.how .signed-mark { display: inline-block; margin-left: .3125rem; padding: 0 .375rem; border: 1px solid var(--line); border-radius: 999px; font-size: .625rem; font-weight: 550; line-height: 1.3; text-decoration: none; vertical-align: .0625rem; }

.fine { color: var(--muted); font-size: .8125rem; line-height: 1.55; margin-bottom: .625rem; }

/* That the record is signed is a fact about it, so it is set as one and not as fine print. */
.signed { font-size: .875rem; line-height: 1.55; margin-bottom: .875rem; }
/* Arrived at from a badge's "signed" link, so the reader is shown where they landed. */
.signed:target { margin-inline: -.75rem; padding: .625rem .75rem; border-radius: 8px; background: var(--raised); }

/* Every time on the record in one column, so they can be compared rather than hunted for. */
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: .3rem 1.5rem;
  margin: 1.25rem 0;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  font-size: .8125rem;
}

dt { color: var(--muted); }

dd { margin: 0; font-variant-numeric: tabular-nums; }

/* Inside a card the rule above it is the card's own edge, so the list needs none. */
section dl { margin: .5rem 0 1rem; padding-top: 0; border-top: 0; }
.side dl { margin: .625rem 0 0; padding-top: .625rem; }

/* The links under a record, ruled off from the record and its disclaimer. */
footer { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--line); }
footer > :last-child { margin-bottom: 0; }

section {
  margin: 0 0 1.25rem;
  padding: 1.25rem 1.375rem;
  border: 1px solid var(--line);
  border-radius: 10px;
}

section > :last-child { margin-bottom: 0; }

form { margin: 0 0 1.5rem; }

label { display: block; margin: 0 0 .75rem; color: var(--muted); font-size: .8125rem; }

input, textarea {
  display: block;
  width: 100%;
  margin-top: .375rem;
  padding: .5rem .625rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  font: .875rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Height comes from the rows attribute, which differs per box. */
textarea { resize: vertical; }

input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

button {
  padding: .5rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--surface);
  font: 500 .9375rem/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
  cursor: pointer;
}

/* A link that starts something, drawn as a button. */
a.button {
  display: inline-block;
  padding: .5rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--surface);
  font-weight: 500;
  font-size: .9375rem;
  line-height: 1.4;
  text-decoration: none;
}

button + button { margin-left: .5rem; border-color: var(--line); background: none; color: var(--ink); }

/* The other choice beside a page's one action, such as Cancel. */
a.button.secondary { border-color: var(--line); background: none; color: var(--ink); }

/* A page's action and its alternative, side by side. */
.choice { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
.choice form { margin: 0; }

/* Ways to verify: one full-width button per method, none filled over the others. */
.choices { display: grid; gap: .5rem; margin-bottom: 1.5rem; }
.choices form { margin: 0; }

.choices button {
  width: 100%;
  text-align: left;
  border-color: var(--line);
  background: var(--surface);
  color: var(--ink);
}

.choices button:hover { border-color: var(--muted); }

/* A provider's mark before a button's label, at the height of the letters. */
button .provider { width: 1rem; height: 1rem; margin-right: .5rem; vertical-align: -.1875rem; }

/* A control that ends something. Filled where it is the page's one action. */
button.danger { border-color: var(--warn); background: var(--warn); }

/*
 * A connection on the settings page: the account's card, then what can be done with it.
 * Its state sits in the card's corner, on the line that names the method.
 */
.connection { position: relative; margin-bottom: 1rem; }

.state {
  position: absolute;
  top: .75rem;
  right: .875rem;
  display: flex;
  align-items: center;
  gap: .375rem;
  height: 1.625rem;
  padding: 0 .75rem 0 .5rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink);
  font-size: .8125rem;
  font-weight: 550;
}

/*
 * The V the badge draws, in the tone that says how the record stands. A record that claims
 * nothing is drawn faint in the text colour, as the badge draws it.
 */
.verdict { flex-shrink: 0; width: 1rem; height: 1rem; }
.verdict.pending { opacity: .45; }
.how .verdict { width: .875rem; height: .875rem; margin-right: .3125rem; vertical-align: -.125rem; }
/* Cropped to its strokes and taller than the heading's letters, centred beside them. */
h1:has(.verdict) { display: flex; align-items: center; gap: .75rem; }
h1 .verdict { width: auto; height: 2.25rem; }

/*
 * In a state pill the V is cropped to its strokes and fills the pill's height, so its arms
 * and its foot meet the border. The pill's left padding keeps the arms clear of its curve.
 */
.state .verdict { width: auto; height: 100%; }

/*
 * A pill's line includes room for descenders below the letters, which leaves its text
 * sitting high. Trimmed to the letters, the padding alone sets the space above and below.
 * In a state pill the word alone is trimmed, so it centres on the V by its letters.
 */
@supports (text-box: trim-both cap alphabetic) {
  .listing { padding: .3125rem .5rem; text-box: trim-both cap alphabetic; }
  .state > span { text-box: trim-both cap alphabetic; }
}

/* Links that sit together on one line, wrapping where there is no room. */
.links { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.25rem; font-size: .875rem; }

/* Under the account's id, with the facts about it rather than the controls. */
.evidence { margin: .375rem 0 0; font-size: .8125rem; }

.connection dl { margin-bottom: .75rem; }
.connection .side > :last-child { margin-bottom: 0; }
.connection pre { margin: .75rem 0; background: var(--surface); }
.connection .actions { margin-top: .875rem; }

/* The buttons for one connection in a row, wrapping where there is no room. */
.actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.actions form { display: contents; }

.actions button, .actions a.button {
  margin: 0;
  padding: .3125rem .75rem;
  border-color: var(--line);
  background: var(--surface);
  color: var(--ink);
  font-size: .8125rem;
}

.actions button:hover, .actions a.button:hover { border-color: var(--muted); }

/* The controls that cannot be undone, together at the foot of the card. */
.ending { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--line); }
.ending form { margin: 0; }

.ending button.danger {
  padding: .3125rem .75rem;
  background: var(--surface);
  color: var(--warn);
  font-size: .8125rem;
}

fieldset { margin: 0 0 1.25rem; padding: 1rem 1.125rem .25rem; border: 1px solid var(--line); border-radius: 8px; }

legend { padding: 0 .375rem; color: var(--muted); font-size: .8125rem; }

fieldset label { display: flex; align-items: baseline; gap: .5rem; color: var(--ink); font-size: .9375rem; }

fieldset input { width: auto; margin: 0; }

fieldset p { margin: .25rem 0 .875rem 1.5rem; color: var(--muted); font-size: .8125rem; }
`;

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
