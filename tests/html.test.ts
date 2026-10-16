import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw } from '../src/server/html.js';

test('values are escaped unless they are markup already', () => {
  const name = '<b>"x" & y</b>';

  assert.equal(
    html`<p title="${name}">${name}${raw('<br>')}${html`<i>${name}</i>`}</p>`.markup,
    '<p title="&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;">&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;<br><i>&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;</i></p>',
  );

  assert.equal(
    html`<p>${[1, false, null, undefined, 'a', [html`<b>2</b>`]]}</p>`.markup,
    '<p>1a<b>2</b></p>',
  );
});

test('a template is written indented, and its line breaks are taken out', () => {
  const name = 'Ada';
  const link = html`<a href="/a">a</a>`;

  // Beside a tag, and at either end of the template, a line break goes entirely.
  assert.equal(
    html`
      <div>
        <p>One</p>
        <p>Two</p>
      </div>
    `.markup,
    '<div><p>One</p><p>Two</p></div>',
  );

  // Between words, and between a word and a value, it is one space.
  assert.equal(
    html`
      <p>
        Signed by
        ${name} on
        the day.
      </p>
    `.markup,
    '<p>Signed by Ada on the day.</p>',
  );

  // Between two values it goes, so values on lines of their own run together.
  assert.equal(
    html`
      ${link}
      ${link}
    `.markup,
    '<a href="/a">a</a><a href="/a">a</a>',
  );

  // Inside a tag, between attributes, it is one space.
  assert.equal(
    html`
      <input
        name="key"
        required>
    `.markup,
    '<input name="key" required>',
  );

  // A space on one line is kept as written, and values are never changed.
  assert.equal(
    html`<p>Is it yours? ${link}</p>${'a\n  b'}`.markup,
    '<p>Is it yours? <a href="/a">a</a></p>a\n  b',
  );
});
