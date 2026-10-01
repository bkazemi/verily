import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class Element {
  children: Element[] = [];
  private text = '';
  href = '';
  rel = '';
  target = '';
  title = '';
  className = '';
  shadowRoot?: Element;
  tagName = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => unknown)[]> = {};
  id = '';
  type = '';
  open = false;

  find(tag: string): Element[] {
    return [
      ...(this.tagName === tag ? [this] : []),
      ...this.children.flatMap((child) => child.find(tag)),
      ...(this.shadowRoot?.find(tag) ?? []),
    ];
  }

  addEventListener(type: string, handler: (event: unknown) => unknown) {
    (this.listeners[type] ??= []).push(handler);
  }

  /** Assignment replaces, as it does on a real element. */
  set onclick(handler: ((event: unknown) => unknown) | null) {
    this.listeners['click'] = handler ? [handler] : [];
  }

  get onclick(): ((event: unknown) => unknown) | null {
    return this.listeners['click']?.[0] ?? null;
  }

  removeEventListener() {}

  showModal() {
    this.open = true;
  }

  checked = false;
  disabled = false;

  /** As a real dialog does, closing fires `close` for whoever is listening. */
  close() {
    this.open = false;

    for (const handler of this.listeners['close'] ?? []) handler({});
  }

  /** Enough of a selector for the dialogs: a tag, optionally `:checked`. */
  querySelector(selector: string): Element | null {
    const [tag, state] = selector.split(':');

    return (
      this.all()
        .slice(1)
        .find((e) => e.tagName === tag && (state !== 'checked' || e.checked)) ?? null
    );
  }

  focus() {}

  remove() {
    const siblings = this.parentNode?.children;

    if (siblings) siblings.splice(siblings.indexOf(this), 1);

    this.parentNode = undefined;
  }

  get nextSibling(): Element | undefined {
    const siblings = this.parentNode?.children ?? [];

    return siblings[siblings.indexOf(this) + 1];
  }

  /** Every element under this one, including through shadow roots. */
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => c.all()), ...(this.shadowRoot?.all() ?? [])];
  }

  attachShadow() {
    this.shadowRoot = new Element();

    return this.shadowRoot;
  }

  parentNode?: Element;

  append(...children: Element[]) {
    for (const child of children) child.parentNode = this;

    this.children.push(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  links(): Element[] {
    return [
      ...(this.tagName === 'a' ? [this] : []),
      ...this.children.flatMap((c) => c.links()),
      ...(this.shadowRoot?.links() ?? []),
    ];
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  get textContent(): string {
    if (this.tagName === 'style') return '';

    return (
      this.text +
      this.children.map((c) => c.textContent).join('') +
      (this.shadowRoot?.textContent ?? '')
    );
  }

  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parentNode = undefined;

    for (const child of children) child.parentNode = this;

    this.text = '';
    this.children = children;
  }
}

test('distributed badge renders current/expired/revoked evidence and fails closed on private or malformed results', async () => {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');

  let fetches = 0;

  let evidence: Record<string, unknown> = {
    id: 'original',
    provider: 'github',
    providerName: 'GitHub',
    siteName: 'Example',
    verifierName: 'Self-hosted Example',
    local: { label: 'Original account', reference: 'member-1' },
    external: { id: '42', handle: '<Alice>', profileUrl: 'https://github.com/alice' },
    evidenceUrl: 'https://site.test/api/verity/connections/original',
    status: 'verified',
    visibility: 'public',
    authenticatedAt: 1,
    approvedAt: 1,
    expiresAt: Date.now() + 60000,
    attestations: {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [{ by: 'provider', method: 'oauth', confirmedAt: 1 }],
    },
  };

  const context = vm.createContext({
    URL,
    CSSStyleSheet: class {
      replaceSync() {}
    },
    location: { href: 'https://site.test/profile', origin: 'https://site.test' },
    document: {
      createElementNS: (_namespace: string, tag: string) => {
        const element = new Element();

        element.tagName = tag;

        return element;
      },
      createElement: (tag: string) => {
        const element = new Element();

        element.tagName = tag;

        return element;
      },
      createTextNode: (text: string) => {
        const el = new Element();

        el.textContent = text;

        return el;
      },
    },
    fetch: async () => {
      fetches += 1;

      return { ok: true, json: async () => evidence };
    },
  });

  vm.runInContext(asset, context);

  const client = context.Verity.init({ backendUrl: '/api/verity' }) as {
    mountBadge(
      element: Element,
      options: { connectionId: string; evidence?: unknown },
    ): Promise<void>;
  };

  const element = new Element();

  await client.mountBadge(element, { connectionId: 'copied-badge' });
  assert.ok(!element.textContent.includes('Account verification'));
  assert.equal(element.textContent, '@<Alice>');

  assert.match(
    element.links()[0]!.attributes['aria-label']!,
    /GitHub @<Alice>: Verified \| via: Self-hosted Example/,
  );

  assert.equal(element.links().length, 1);
  const logo = element.find('svg');

  assert.equal(logo.length, 2);
  assert.equal(logo[1]!.attributes['viewBox'], '0 0 16 16');
  assert.equal(logo[0]!.attributes['viewBox'], '-4 -4 264 264');

  assert.deepEqual(
    logo[0]!.find('path').map((path) => path.attributes['stroke']),
    ['#D3444C', '#149766'],
  );

  assert.ok(!element.textContent.includes('✓'));
  assert.equal(element.links().at(-1)!.href, 'https://site.test/api/verity/connections/original');

  // A refresh keeps the pill on screen while it asks, and finding the same evidence
  // leaves the very same nodes in place: a check nobody needed changes nothing.
  const drawn = element.links()[0]!;
  const refresh = client.mountBadge(element, { connectionId: 'original' });

  assert.equal(element.links()[0], drawn);
  assert.ok(!element.textContent.includes('Checking'));
  await refresh;
  assert.equal(element.links()[0], drawn);

  // Evidence handed over is drawn from what the caller already has, not fetched again.
  const seeded = new Element();
  const asked = fetches;

  await client.mountBadge(seeded, { connectionId: 'original', evidence });
  assert.equal(fetches, asked);
  assert.equal(seeded.textContent, '@<Alice>');
  assert.equal(seeded.links().length, 1);

  // A badge with nothing in hand draws the pill and its mark at once, claiming nothing,
  // and the answer fills that same pill in rather than replacing it.
  const cold = new Element();
  const checking = client.mountBadge(cold, { connectionId: 'original' });
  const frame = cold.find('a')[0]!;
  const mark = cold.find('svg')[0]!;

  assert.equal(frame.className, 'badge pending');
  assert.equal(mark.attributes['class'], 'mark pending');

  assert.deepEqual(
    mark.find('path').map((path) => path.attributes['stroke']),
    ['currentColor', 'currentColor'],
  );

  assert.equal(cold.textContent, '');
  await checking;
  assert.equal(cold.find('a')[0], frame);
  assert.equal(cold.find('svg')[0], mark);
  assert.equal(mark.attributes['class'], 'mark current');

  assert.deepEqual(
    mark.find('path').map((path) => path.attributes['stroke']),
    ['#D3444C', '#149766'],
  );

  assert.equal(cold.textContent, '@<Alice>');

  // Evidence that fails its own checks is not drawn, however it arrived.
  const refused = new Element();

  await client.mountBadge(refused, {
    connectionId: 'original',
    evidence: { ...evidence, expiresAt: 'tomorrow' },
  });

  assert.match(refused.textContent, /Unavailable/);

  // Its dash is drawn too, about the middle of the same box as the clock.
  const dash = refused.find('svg').at(-1)!;

  assert.equal(dash.attributes['class'], 'glyph dash');
  assert.equal(dash.attributes['viewBox'], '0 0 16 16');

  assert.deepEqual(
    dash.find('path').map((path) => path.attributes['d']),
    ['M4.4 8h7.2'],
  );

  assert.ok(!refused.textContent.includes('–'));
  assert.equal(refused.links().length, 0);

  evidence = { ...evidence, expiresAt: 1 };
  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Expired/);
  assert.equal(element.find('svg').length, 3);

  // The clock is drawn, so it is centred by its own geometry and not by a font's.
  const clock = element.find('svg').at(-1)!;

  assert.equal(clock.attributes['class'], 'glyph clock');
  assert.equal(clock.attributes['viewBox'], '0 0 16 16');

  assert.deepEqual(
    clock.find('circle').map((c) => [c.attributes['cx'], c.attributes['cy']]),
    [['8', '8']],
  );

  assert.ok(!element.textContent.includes('◷'));

  assert.deepEqual(
    element
      .find('svg')[0]!
      .find('path')
      .map((path) => path.attributes['stroke']),
    ['#149766', '#D3444C'],
  );

  assert.equal(element.find('svg')[0]!.find('path')[1]!.attributes['stroke-dasharray'], '108 176');
  assert.equal(element.links()[0]!.children.at(-1)!.className, 'icon');

  // A proof nobody has been able to read lately is inside its approval, so it is unconfirmed.
  evidence = { ...evidence, status: 'unconfirmed', expiresAt: Date.now() + 60000 };
  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Unconfirmed/);
  assert.ok(!element.textContent.includes('Expired'));

  // A key in the pill: its own mark, its fingerprint, and no @ in front of it.
  evidence = {
    ...evidence,
    status: 'verified',
    provider: 'openpgp',
    providerName: 'OpenPGP',
    external: {
      id: 'FPR',
      kind: 'key',
      handle: 'alice@example.test',
      profileUrl: 'https://k.test',
    },
  };

  await client.mountBadge(element, { connectionId: 'original' });

  const pill: string = element.textContent;

  // The address a reader knows, written as it is. An @ in front would read as
  // @alice@example.test, and it was never a handle to begin with.
  assert.equal(pill, 'alice@example.test');
  assert.ok(!pill.startsWith('@'));
  assert.ok(!pill.includes('OpenPGP'));
  assert.equal(element.find('svg').length, 2);
  assert.equal(element.find('svg')[1]!.attributes['class'], 'provider');

  evidence = {
    ...evidence,
    provider: 'github',
    providerName: 'GitHub',
    external: { id: '42', handle: '<Alice>', profileUrl: 'https://github.com/alice' },
    status: 'revoked',
    expiresAt: 1,
  };

  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Revoked/);
  assert.equal(element.find('svg').at(-1)!.attributes['class'], 'glyph dash');
  assert.ok(!element.textContent.includes('–'));
  assert.equal(element.find('svg').length, 3);

  assert.deepEqual(
    element
      .find('svg')[0]!
      .find('path')
      .map((path) => path.attributes['stroke']),
    ['#149766', '#D3444C'],
  );

  assert.equal(element.find('svg')[0]!.find('path')[1]!.attributes['stroke-dasharray'], '108 176');
  assert.equal(element.links()[0]!.children.at(-1)!.className, 'icon');

  const declared = { by: 'backend', method: 'declared', confirmedAt: 1 };

  // A well-formed pair of attestations changes nothing about how the badge renders.
  evidence = {
    ...evidence,
    attestations: {
      local: declared,
      external: [
        {
          by: 'provider',
          method: 'gist',
          artifactUrl: 'https://gist.github.com/alice/abc',
          expect: 'verity-token',
          confirmedAt: 2,
        },
      ],
    },
  };

  await client.mountBadge(element, { connectionId: 'original' });
  assert.equal(element.links().length, 1);

  for (const changes of [
    { visibility: 'unlisted' },
    { external: { id: '42', handle: 'alice', profileUrl: 'javascript:alert(1)' } },
    { expiresAt: 'tomorrow' },
    // One side described and the other missing would let a renderer imply a method
    // for a side that never reported one.
    { attestations: undefined },
    { providerName: undefined },
    { attestations: { local: declared } },
    { attestations: { local: declared, external: [{ ...declared, by: 'nobody' }] } },
    // The first method is the one a record is judged by, so there must be one.
    { attestations: { local: declared, external: [] } },
    // An artifact url is rendered as a link, so only http(s) may ever reach an href.
    {
      attestations: {
        local: declared,
        external: [{ ...declared, by: 'provider', artifactUrl: 'javascript:alert(1)' }],
      },
    },
  ]) {
    const previous = evidence;

    evidence = { ...previous, ...changes };
    await client.mountBadge(element, { connectionId: 'original' });
    assert.match(element.textContent, /Unavailable/);
    assert.equal(element.links().length, 0);

    assert.deepEqual(
      element
        .find('svg')[0]!
        .find('path')
        .map((path) => path.attributes['stroke']),
      ['#149766', '#D3444C'],
    );

    assert.ok(!(element.textContent as string).includes('<Alice>'));
    evidence = previous;
  }
});

/**
 * Mounts a badge, clicks it, and returns the dialog it opened. Attestations vary per case
 * because how each side was established is the thing under test; everything else is fixed.
 */
async function renderDialog(
  attestations: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');

  const evidence = {
    id: 'c1',
    provider: 'github',
    providerName: 'GitHub',
    siteName: 'site.test',
    verifierName: 'verifier.test',
    local: {
      label: 'Alice',
      reference: 'site.test author',
      profileUrl: 'https://site.test/about/',
    },
    external: { id: '11813054', handle: 'alice', profileUrl: 'https://github.com/alice' },
    evidenceUrl: 'https://verifier.test/api/verity/connections/c1',
    status: 'verified',
    visibility: 'public',
    authenticatedAt: 1,
    approvedAt: 1,
    expiresAt: Date.now() + 60000,
    attestations,
    ...overrides,
  };

  const body = new Element();

  const element = (tag: string) => {
    const created = new Element();

    created.tagName = tag;

    return created;
  };

  const context = vm.createContext({
    URL,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    CSSStyleSheet: class {
      replaceSync() {}
    },
    // The renderer branches on these, so the stub must satisfy instanceof.
    HTMLElement: { [Symbol.hasInstance]: (value: unknown) => value instanceof Element },
    HTMLAnchorElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'a',
    },
    HTMLDialogElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'dialog',
    },
    location: { href: 'https://site.test/profile', origin: 'https://site.test' },
    document: {
      body,
      createElementNS: (_namespace: string, tag: string) => element(tag),
      createElement: element,
      createTextNode: (text: string) => {
        const created = new Element();

        created.textContent = text;

        return created;
      },
    },
    fetch: async () => ({ ok: true, json: async () => evidence }),
  });

  vm.runInContext(asset, context);

  const client = context.Verity.init({ backendUrl: 'https://verifier.test/api/verity' }) as {
    mountBadge(host: Element, options: { connectionId: string }): Promise<void>;
  };

  const host = new Element();

  await client.mountBadge(host, { connectionId: 'c1' });

  const pill = host.links()[0]!;
  const open = pill.listeners['click']?.[0];

  assert.ok(open, 'the badge opens the dialog on click');
  open({ button: 0, preventDefault() {} });

  const opened = body.all().find((found) => found.tagName === 'dialog')!;

  // The dialog is drawn from the record the pill holds before it is shown, so it opens
  // at its full size rather than growing out of a one-line placeholder.
  assert.ok(opened, 'a dialog is attached to the document');
  assert.ok(!opened.textContent.includes('Checking verification'));
  assert.match(opened.textContent, /Verification does not guarantee/);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const dialog = body.all().find((found) => found.tagName === 'dialog')!;

  assert.ok(dialog, 'a dialog is attached to the document');

  return {
    dialog,
    cards: dialog.all().filter((found) => found.className.includes('account')),
  };
}

test('the evidence dialog presents both sides of a link as parallel cards', async () => {
  const { dialog, cards } = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [
      {
        by: 'provider',
        method: 'gist',
        artifactUrl: 'https://gist.github.com/alice/abc',
        expect: 'verity-c1',
        confirmedAt: 2,
      },
    ],
  });

  // Both sides render as cards, so neither reads as a caption on the other.
  assert.equal(cards.length, 2);

  const [local, external] = cards as [Element, Element];

  // No kind was supplied, so the card names the site and asserts nothing more.
  assert.match(local.textContent, /site\.test/);
  assert.ok(!local.textContent.includes('Account on'));
  assert.match(local.textContent, /Alice/);
  // The site's own reference would only restate the heading and label.
  assert.ok(!local.textContent.includes('site.test author'));

  assert.match(external.textContent, /GitHub/);
  assert.match(external.textContent, /@alice/);
  assert.match(external.textContent, /11813054/);

  // The old caption assumed the local side was a person's account.
  assert.ok(!dialog.textContent.includes('For Alice on'));
  // The two cards are joined by a link mark, not by words.
  assert.ok(!dialog.textContent.includes('This verification links'));
  assert.equal(dialog.all().filter((e) => e.attributes['class'] === 'joiner').length, 1);

  // Each side says how it was established, on that side, with neither ranked.
  assert.match(local.textContent, /Stated by site\.test/);
  assert.match(external.textContent, /Published a proof on GitHub/);
  assert.ok(!local.textContent.includes('Published a proof'));
  assert.ok(!external.textContent.includes('Stated by'));

  // The proof explains the verified state, so it is read after that state, not before it.
  assert.deepEqual(
    external.children.map((child) => child.className || child.tagName),
    ['h3', 'a', 'muted reference', 'summary', 'muted method', 'dl'],
  );

  // A published proof is reachable, so a reader can check it without trusting this backend.
  // The method's name is the link, and its title says where it leads and when it was read.
  const proof = external
    .links()
    .find((link) => link.textContent === 'Published a proof on GitHub')!;

  assert.equal(proof.href, 'https://gist.github.com/alice/abc');
  assert.match(proof.title, /^View the proof at gist\.github\.com \| Last checked /);

  // Every link out of the dialog opens beside it: the record is read against what it
  // links to, and following one in place would take the reader off the page.
  for (const link of dialog.links()) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noreferrer');
  }

  // Every time on the card sits in one table, so none of them read as prose.
  assert.deepEqual(
    external
      .find('dl')[0]!
      .children.filter((child) => child.tagName === 'dt')
      .map((child) => child.textContent),
    ['Approved', 'Valid until', 'Last checked'],
  );

  // The flattened sentence described one method for both sides and named neither.
  assert.ok(!dialog.textContent.includes('proved control of it with their provider'));
  assert.ok(!dialog.textContent.includes('does not check'));

  // Nothing below the cards may name a provider: a subject proved a second way gets a
  // second card, and everything under them has to still read correctly when it does.
  const footer = dialog.all().find((found) => found.className === 'muted explanation')!;

  assert.ok(footer, 'the cards are followed by a footer');
  assert.ok(!footer.textContent.includes('GitHub'));
  assert.ok(!footer.textContent.includes('alice'));
  assert.ok(!footer.textContent.includes('site.test'));
});

test('an unrecognised method is omitted rather than described, and oauth offers no proof link', async () => {
  const unknown = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'telepathy', confirmedAt: 2 }],
  });

  assert.match(unknown.dialog.textContent, /Stated by site\.test/);

  // Nothing is claimed about a method this renderer does not understand.
  assert.ok(!unknown.dialog.textContent.includes('telepathy'));
  assert.ok(!unknown.dialog.links().some((link) => link.title.startsWith('View the proof')));

  // oauth leaves no public artifact, so it is named without offering a link to open.
  const signedIn = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'oauth', confirmedAt: 2 }],
  });

  assert.match(signedIn.dialog.textContent, /Signed in with GitHub/);
  assert.ok(!signedIn.dialog.links().some((link) => link.title.startsWith('View the proof')));
  assert.ok(!signedIn.dialog.textContent.includes('last checked'));
});

test('a proof gone unread reads as unconfirmed, not as an approval that ran out', async () => {
  const attestations = {
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [
      {
        by: 'provider',
        method: 'gist',
        artifactUrl: 'https://gist.github.com/alice/abc',
        confirmedAt: 1,
      },
    ],
  };

  const stale = await renderDialog(attestations, { status: 'unconfirmed' });

  assert.match(stale.dialog.textContent, /Unconfirmed/);
  assert.ok(!stale.dialog.textContent.includes('Expired'));

  // The approval itself is untouched, so the record still reads forward to its own end.
  assert.match(stale.dialog.textContent, /Valid until/);

  // The proof is still linked: an unread proof is not a withdrawn one.
  assert.ok(stale.dialog.links().some((link) => link.title.startsWith('View the proof')));
  assert.match(stale.dialog.textContent, /Last checked/);

  const lapsed = await renderDialog(attestations, { status: 'expired', expiresAt: 1 });

  assert.match(lapsed.dialog.textContent, /Expired on/);
  assert.ok(!lapsed.dialog.textContent.includes('Unconfirmed'));
});

test('a key is named by its fingerprint, with no @ and the provider written once', async () => {
  const fingerprint = '7FDEB37E4F6EAD8E2FEFD8511347D93FEB1342AF';

  const { cards } = await renderDialog(
    {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [
        {
          by: 'provider',
          method: 'signature',
          artifactUrl: 'https://verifier.test/api/verity/connections/c1/proof',
          hosted: true,
          confirmedAt: 2,
        },
      ],
    },
    {
      provider: 'openpgp',
      providerName: 'OpenPGP',
      external: {
        id: fingerprint,
        kind: 'key',
        handle: 'alice@example.test',
        profileUrl: 'https://keys.example/search',
      },
    },
  );

  const external = cards[1]!;

  // The address the key signed for, above the fingerprint that is the actual identity.
  assert.match(external.textContent, /alice@example\.test/);
  assert.match(external.textContent, new RegExp(fingerprint));

  // No @ in front of it: it is not a handle, and @alice@example.test is not a name.
  assert.ok(!external.textContent.includes('@alice'));

  // The heading carries a mark and the name. It used to carry the name twice, because the
  // mark fell back to writing it whenever a provider had none of its own.
  const heading = external.find('h3')[0]!;

  assert.equal(heading.textContent, 'OpenPGP');
  assert.equal(external.textContent.split('OpenPGP').length - 1, 1);
  assert.equal(heading.find('svg')[0]!.attributes['class'], 'provider');
  assert.match(external.textContent, /Proved with a signature/);
});

test('an account still reads as a handle, and its provider mark is still drawn', async () => {
  const { cards } = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'oauth', confirmedAt: 2 }],
  });

  const heading = cards[1]!.find('h3')[0]!;

  assert.match(cards[1]!.textContent, /@alice/);
  assert.equal(heading.textContent, 'GitHub');
  assert.equal(heading.find('svg').length, 1);
});

test('methods after the first sit beneath it, each with its own proof', async () => {
  const { cards } = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [
      { by: 'provider', method: 'oauth', confirmedAt: 2 },
      {
        by: 'provider',
        method: 'backlink',
        artifactUrl: 'https://github.com/alice',
        confirmedAt: 3,
      },
    ],
  });

  const text = cards[1]!.textContent;

  const additional = cards[1]!
    .all()
    .filter((found) => found.className.includes('additional'))
    .map((line) => line.textContent);

  assert.match(text, /Signed in with GitHub\+ Linked back to site\.test/);
  assert.deepEqual(additional, ['+ Linked back to site.test']);

  // Each proof is named by its own link, so two on one card cannot be mistaken for each other.
  const backlink = cards[1]!
    .links()
    .find((link) => link.textContent === 'Linked back to site.test')!;

  assert.equal(backlink.href, 'https://github.com/alice');
  assert.match(backlink.title, /^View the proof at github\.com \| Last checked /);

  // The method is named in words, never by the markup it happens to use.
  assert.ok(!text.includes('rel='));
});

test('a page read by a link back is a record the badge will show', async () => {
  const { cards } = await renderDialog(
    {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [
        {
          by: 'provider',
          method: 'backlink',
          artifactUrl: 'https://example.test/about',
          confirmedAt: 2,
        },
      ],
    },
    {
      provider: 'link',
      providerName: 'Web',
      external: {
        id: 'https://example.test/about',
        kind: 'page',
        handle: 'example.test/about',
        profileUrl: 'https://example.test/about',
      },
    },
  );

  assert.match(cards[1]!.textContent, /example\.test\/about/);
  assert.ok(!cards[1]!.textContent.includes('@example'));
  // A link-back provider the site named itself still gets the globe.
  assert.ok(globeIn(cards[1]!));
});

/** Whether an element draws the globe: its equator is the one line only the globe has. */
function globeIn(element: Element): boolean {
  return element.all().some((e) => e.tagName === 'path' && e.attributes.d === 'M1.5 8h13');
}

test('the version stamped on a record is the one the package ships', async () => {
  const { version } = await import('../src/version.js');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(version, `v${manifest.version}`);
});

test('the dialog shows the full version beside the logotype, as text', async () => {
  const { version } = await import('../src/version.js');

  const { dialog } = await connectHarness(async (path) =>
    path === '/methods' ? connectMethods : approvalView,
  );

  const footer = dialog.all().find((e) => e.tagName === 'footer')!;

  assert.equal(footer.all().find((e) => e.tagName === 'span')!.textContent, version);
});

/**
 * The connect dialog over a scripted backend. Each request is answered by `answer`, which
 * may hold one back to model a slow server; the sign-in poll is fired by hand.
 */
async function connectHarness(answer: (path: string, body?: string) => Promise<unknown>) {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');
  const body = new Element();
  const polls: (() => Promise<void>)[] = [];

  const element = (tag: string) => {
    const created = new Element();

    created.tagName = tag;

    return created;
  };

  const context = vm.createContext({
    URL,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: (handler: () => Promise<void>) => polls.push(handler),
    clearInterval: () => {},
    CSSStyleSheet: class {
      replaceSync() {}
    },
    HTMLElement: { [Symbol.hasInstance]: (value: unknown) => value instanceof Element },
    HTMLAnchorElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'a',
    },
    HTMLTextAreaElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'textarea',
    },
    HTMLDialogElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'dialog',
    },
    location: { href: 'https://site.test/settings', origin: 'https://site.test' },
    window: {
      open: () => ({
        closed: false,
        location: { href: '' },
        close() {
          this.closed = true;
        },
      }),
    },
    document: {
      body,
      createElementNS: (_namespace: string, tag: string) => element(tag),
      createElement: element,
      createTextNode: (text: string) => {
        const node = new Element();

        node.textContent = text;

        return node;
      },
    },
    fetch: async (url: string, init?: { body?: string }) => {
      const data = await answer(new URL(url).pathname.replace('/api/verity', ''), init?.body);

      return { ok: true, json: async () => data };
    },
  });

  vm.runInContext(asset, context);

  const client = context.Verity.init({ backendUrl: '/api/verity' }) as {
    openConnect(opener: Element): Promise<{ outcome: string; connectionId?: string }>;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const result = client.openConnect(new Element());

  await settle();

  const dialog = body.find('dialog')[0]!;

  const press = async (label: string) => {
    const button = dialog.all().find((e) => e.tagName === 'button' && e.textContent === label);

    assert.ok(button, `no ${label} button`);
    await button.onclick?.({});
    await settle();
  };

  return { dialog, polls, press, result, settle };
}

const connectMethods = {
  siteName: 'Site',
  verifierName: 'site.test',
  local: { heading: 'Site', value: 'Alice' },
  methods: [{ provider: 'github', method: 'oauth', name: 'GitHub', action: 'Sign in with GitHub' }],
};

const approvalView = {
  id: 'f1',
  phase: 'approval',
  provider: { id: 'github', name: 'GitHub', method: 'oauth' },
  local: { heading: 'Site', value: 'Alice' },
  external: { id: '42', handle: 'alice', profileUrl: 'https://github.com/alice' },
};

test('a sign-in answer that arrives after the holder cancelled does not bring the flow back', async () => {
  let late!: (value: unknown) => void;

  const { dialog, polls, press, settle } = await connectHarness(async (path) => {
    if (path === '/methods') return connectMethods;

    if (path === '/sessions')
      return {
        id: 'f1',
        phase: 'pending',
        provider: { id: 'github', name: 'GitHub', method: 'oauth' },
        authorizationUrl: 'https://github.test/authorize',
      };

    return new Promise((resolve) => (late = resolve));
  });

  await press('Sign in with GitHub');
  assert.match(dialog.textContent, /Continue in the GitHub window/);

  // The poll asks, the holder cancels, and only then does the answer come back.
  const polled = polls.at(-1)!();

  await press('Cancel');
  late(approvalView);
  await polled;
  await settle();

  assert.match(dialog.textContent, /Sign in with GitHub/);
  assert.doesNotMatch(dialog.textContent, /Confirm connection/);
});

test('closing the dialog while an approval is out still reports the connection it made', async () => {
  let approved!: (value: unknown) => void;

  const { dialog, press, result } = await connectHarness(async (path) => {
    if (path === '/methods') return connectMethods;

    if (path === '/sessions') return approvalView;

    return new Promise((resolve) => (approved = resolve));
  });

  await press('Sign in with GitHub');
  const confirming = press('Confirm connection');

  dialog.close();
  approved({ outcome: 'complete', connectionId: 'c9' });
  await confirming;

  assert.deepEqual({ ...(await result) }, { outcome: 'complete', connectionId: 'c9' });
});

test('a holder with one visibility to choose is shown it, not offered a choice, and it is what is sent', async () => {
  for (const only of ['public', 'unlisted'] as const) {
    const sent: string[] = [];

    const { dialog, press } = await connectHarness(async (path, body) => {
      if (path === '/methods') return connectMethods;

      if (path === '/sessions') return { ...approvalView, visibilities: [only] };

      sent.push(body!);

      return { outcome: 'complete', connectionId: 'c9' };
    });

    await press('Sign in with GitHub');

    assert.equal(dialog.all().filter((e) => e.tagName === 'input').length, 0);

    assert.match(
      dialog.textContent,
      only === 'public' ? /Public: anyone/ : /Unlisted: only people/,
    );

    assert.doesNotMatch(dialog.textContent, only === 'public' ? /Unlisted/ : /Public/);

    await press('Confirm connection');
    assert.equal(JSON.parse(sent[0]!).visibility, only);
  }

  // Told of both, or told nothing by an older backend, it offers the choice as before.
  for (const visibilities of [['unlisted', 'public'], undefined]) {
    const { dialog, press } = await connectHarness(async (path) => {
      if (path === '/methods') return connectMethods;

      return { ...approvalView, ...(visibilities ? { visibilities } : {}) };
    });

    await press('Sign in with GitHub');
    assert.equal(dialog.all().filter((e) => e.tagName === 'input').length, 2);
  }
});

test('cancel cannot race a confirmation that is still out', async () => {
  const answers: ((value: unknown) => void)[] = [];

  const { dialog, press, result } = await connectHarness(async (path) => {
    if (path === '/methods') return connectMethods;

    if (path === '/sessions') return approvalView;

    return new Promise((resolve) => answers.push(resolve));
  });

  await press('Sign in with GitHub');
  const confirming = press('Confirm connection');
  const cancel = dialog.all().find((e) => e.tagName === 'button' && e.textContent === 'Cancel')!;

  // Both decisions are held while one is out, and a click on the other sends nothing.
  assert.equal(cancel.disabled, true);
  await press('Cancel');
  assert.equal(answers.length, 1);

  dialog.close();
  answers[0]!({ outcome: 'complete', connectionId: 'c9' });
  await confirming;

  assert.deepEqual({ ...(await result) }, { outcome: 'complete', connectionId: 'c9' });
});

test('a link-back method is marked with the globe, and GitHub keeps its own mark', async () => {
  const { dialog, press } = await connectHarness(async () => ({
    ...connectMethods,
    methods: [
      { provider: 'link', method: 'backlink', name: 'your website', action: 'Link back' },
      { provider: 'github', method: 'oauth', name: 'GitHub', action: 'Sign in with GitHub' },
      { provider: 'github', method: 'backlink', name: 'GitHub', action: 'Link back from GitHub' },
    ],
  }));

  const choice = (label: string) =>
    dialog.all().find((e) => e.tagName === 'button' && e.textContent.includes(label))!;

  assert.ok(globeIn(choice('Link back')));
  await press('GitHub2 ways ›');
  assert.ok(!globeIn(choice('Link back from GitHub')));
});

test('a link in the instructions opens in a new tab, and only if it is http(s)', async () => {
  const { dialog } = await connectHarness(async (path) => {
    if (path === '/methods')
      return {
        ...connectMethods,
        methods: [
          { provider: 'github', method: 'gist', name: 'GitHub', action: 'Publish a proof' },
        ],
      };

    return {
      id: 'f1',
      phase: 'pending',
      provider: { id: 'github', name: 'GitHub', method: 'gist' },
      artifact: 'location',
      field: 'Address of your published proof',
      instructions: [
        [
          'Publish at ',
          { text: 'gist.github.com', href: 'https://gist.github.com/' },
          ' or ',
          { text: 'here', href: 'javascript:alert(1)' },
          '.',
        ],
        { code: 'Verity proof' },
      ],
    };
  });

  await dialog
    .all()
    .find((e) => e.tagName === 'button' && e.textContent.includes('Publish a proof'))!
    .onclick?.({});

  await new Promise((resolve) => setTimeout(resolve, 0));

  const links = dialog.links();

  assert.equal(links.length, 1);
  assert.equal(links[0]!.href, 'https://gist.github.com/');
  assert.equal(links[0]!.target, '_blank');
  assert.equal(links[0]!.textContent, 'gist.github.com');
  assert.match(dialog.textContent, /Publish at gist\.github\.com or here\./);
});

/** A page with the badge script loaded, answering each connection id from `served`. */
async function groupHarness(served: Record<string, unknown>, hold?: () => Promise<void>) {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');
  const body = new Element();
  const asked: string[] = [];
  const defined: Record<string, new () => Element> = {};
  const polls: (() => void)[] = [];
  let early: Record<string, unknown> = {};

  /** Enough of an element for the badge's own class to extend and be constructed. */
  class Host extends Element {
    isConnected = true;

    constructor() {
      super();
      // An upgraded element already carries whatever the page assigned to it.
      Object.assign(this, early);
    }

    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }
  }

  const element = (tag: string) => {
    const created = new Element();

    created.tagName = tag;

    return created;
  };

  const context = vm.createContext({
    URL,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    // Kept, so a test can run a dialog's periodic check when it chooses to.
    setInterval: (handler: () => void) => polls.push(handler),
    clearInterval: () => {},
    CSSStyleSheet: class {
      replaceSync() {}
    },
    Object,
    queueMicrotask,
    HTMLElement: Host,
    customElements: {
      get: (name: string) => defined[name],
      define: (name: string, constructor: new () => Element) => (defined[name] = constructor),
    },
    HTMLAnchorElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'a',
    },
    HTMLDialogElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'dialog',
    },
    location: { href: 'https://site.test/profile', origin: 'https://site.test' },
    document: {
      body,
      createElementNS: (_namespace: string, tag: string) => element(tag),
      createElement: element,
      createTextNode: (text: string) => {
        const created = new Element();

        created.textContent = text;

        return created;
      },
    },
    fetch: async (url: string) => {
      const id = new URL(url).pathname.split('/').at(-1)!;

      asked.push(id);

      // Held back on request, to model an answer that arrives after the page has moved on.
      await hold?.();

      return { ok: id in served, json: async () => served[id] };
    },
  });

  vm.runInContext(asset, context);

  const verity = context.Verity as {
    init(options: { backendUrl: string }): {
      mountBadges(host: Element, options: { connectionIds: string[] }): Promise<void>;
    };
    presentConnections(host: Element, records: unknown): void;
  };

  /** Opens the dialog from a host's pill and returns its account cards, in order. */
  const cards = async (host: Element) => {
    const pill = [...host.find('a'), ...host.find('button')][0]!;

    pill.listeners['click']![0]!({ button: 0, preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dialog = body.all().find((found) => found.tagName === 'dialog')!;

    return { dialog, cards: dialog.all().filter((found) => found.className.includes('account')) };
  };

  /** Constructs an element as an upgrade does: over properties the page set beforehand. */
  const upgrade = (name: string, assigned: Record<string, unknown>) => {
    early = assigned;

    try {
      return new defined[name]!();
    } finally {
      early = {};
    }
  };

  return { verity, asked, cards, defined, polls, upgrade };
}

/** One of a subject's linked accounts, as evidence. */
const linked = (id: string, handle: string, connectedAt: number, overrides: object = {}) => ({
  id,
  provider: 'github',
  providerName: 'GitHub',
  siteName: 'site.test',
  verifierName: 'verifier.test',
  local: { label: 'Alice', reference: 'member-1' },
  external: { id: `ext-${id}`, handle, profileUrl: `https://github.com/${handle}` },
  evidenceUrl: `https://verifier.test/api/verity/connections/${id}`,
  status: 'verified',
  visibility: 'public',
  connectedAt,
  authenticatedAt: 900,
  approvedAt: 900,
  expiresAt: Date.now() + 60000,
  attestations: {
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'oauth', confirmedAt: 1 }],
  },
  ...overrides,
});

test('several accounts of one subject are one pill: the first connected, then how many more', async () => {
  const { verity, cards } = await groupHarness({
    // Listed out of order, and all renewed at the same moment since.
    third: linked('third', 'carol', 300),
    first: linked('first', 'alice', 100),
    second: linked('second', 'bob', 200),
  });

  const client = verity.init({ backendUrl: 'https://verifier.test/api/verity' });
  const host = new Element();

  await client.mountBadges(host, { connectionIds: ['third', 'first', 'second', 'missing'] });

  // One mark, the first connected account, and the rest as a number. The id that could
  // not be read is left out and takes nothing else down with it.
  assert.equal(host.textContent, '@alice+2');
  assert.equal(host.links().length, 1);
  assert.equal(host.links()[0]!.href, 'https://verifier.test/api/verity/connections/first');
  assert.match(host.links()[0]!.attributes['aria-label']!, /GitHub @alice and 2 more: Verified/);

  // The one dialog: the subject once, then each account in the order it was connected.
  const opened = await cards(host);

  assert.equal(opened.cards.length, 4);
  assert.match(opened.cards[0]!.textContent, /Alice/);

  assert.deepEqual(
    opened.cards.slice(1).map((card) => card.textContent.match(/@(alice|bob|carol|dave)/)![1]),
    ['alice', 'bob', 'carol'],
  );

  assert.equal(opened.dialog.textContent.match(/Verification does not guarantee/g)!.length, 1);
});

test('a lapsed account never leads the pill or counts, but keeps its place in the dialog', async () => {
  const { verity, cards } = await groupHarness({
    first: linked('first', 'alice', 100, { status: 'expired', expiresAt: 1 }),
    second: linked('second', 'bob', 200),
    third: linked('third', 'carol', 300, { status: 'revoked', revokedAt: 5 }),
    fourth: linked('fourth', 'dave', 400),
  });

  const client = verity.init({ backendUrl: 'https://verifier.test/api/verity' });
  const host = new Element();

  await client.mountBadges(host, { connectionIds: ['first', 'second', 'third', 'fourth'] });

  // Two are verified now: the earlier of them leads, and the other is the one more.
  assert.equal(host.textContent, '@bob+1');

  const opened = await cards(host);

  assert.deepEqual(
    opened.cards.slice(1).map((card) => card.textContent.match(/@(alice|bob|carol|dave)/)![1]),
    ['alice', 'bob', 'carol', 'dave'],
  );

  assert.match(opened.cards[1]!.textContent, /Expired/);
  assert.match(opened.cards[3]!.textContent, /Revoked/);

  // With none verified, the first connected is shown as what it is, with no count.
  const lapsed = await groupHarness({
    first: linked('first', 'alice', 100, { status: 'expired', expiresAt: 1 }),
    second: linked('second', 'bob', 200, { status: 'revoked', revokedAt: 5 }),
  });

  const none = new Element();

  await lapsed.verity
    .init({ backendUrl: 'https://verifier.test/api/verity' })
    .mountBadges(none, { connectionIds: ['second', 'first'] });

  assert.match(none.textContent, /^@aliceExpired$/);
});

test('accounts of different subjects, or none readable, are not presented as one', async () => {
  const { verity } = await groupHarness({
    mine: linked('mine', 'alice', 100),
    theirs: linked('theirs', 'mallory', 200, {
      local: { label: 'Mallory', reference: 'member-2' },
    }),
    elsewhere: linked('elsewhere', 'eve', 300, { siteName: 'other.test' }),
    hidden: linked('hidden', 'bob', 400, { visibility: 'unlisted' }),
  });

  const client = verity.init({ backendUrl: 'https://verifier.test/api/verity' });

  for (const ids of [
    ['mine', 'theirs'],
    ['mine', 'elsewhere'],
    ['nothing', 'nowhere'],
  ]) {
    const host = new Element();

    await client.mountBadges(host, { connectionIds: ids });
    assert.match(host.textContent, /Unavailable/, ids.join(' '));
    assert.equal(host.links().length, 0);
  }

  // A record the public may not read is never drawn from a fetch, even beside one it may.
  const host = new Element();

  await client.mountBadges(host, { connectionIds: ['mine', 'hidden'] });
  assert.equal(host.textContent, '@alice');
});

test('records the page hands over are drawn without a fetch, unlisted ones with no link', async () => {
  const { verity, asked, cards } = await groupHarness({});

  const records = [
    linked('second', 'bob', 200, { visibility: 'unlisted' }),
    linked('first', 'alice', 100, { visibility: 'unlisted' }),
  ];

  const host = new Element();

  verity.presentConnections(host, records);
  assert.equal(host.textContent, '@alice+1');

  // Nobody can open an unlisted record's page, so the pill is a button and links nowhere.
  assert.equal(host.links().length, 0);
  assert.equal(host.find('button').length, 1);

  const opened = await cards(host);

  assert.deepEqual(
    opened.cards.slice(1).map((card) => card.textContent.match(/@(alice|bob|carol|dave)/)![1]),
    ['alice', 'bob'],
  );

  // The verifier is named on each card and linked from none of them.
  assert.equal(opened.dialog.textContent.match(/via: verifier\.test/g)!.length, 2);
  assert.ok(opened.dialog.links().every((link) => !link.href.includes('verifier.test')));
  assert.deepEqual(asked, []);

  // A public record handed over keeps its link, and one alone is the pill it always was.
  const shown = new Element();

  verity.presentConnections(shown, [linked('only', 'alice', 100)]);
  assert.equal(shown.textContent, '@alice');
  assert.equal(shown.links()[0]!.href, 'https://verifier.test/api/verity/connections/only');

  for (const bad of [
    undefined,
    [],
    'records',
    [{ id: 'x' }],
    [records[0], linked('z', 'eve', 1, { local: { label: 'Eve', reference: 'member-9' } })],
    [
      linked('y', 'eve', 1, {
        external: { id: 'e', handle: 'eve', profileUrl: 'javascript:alert(1)' },
      }),
    ],
  ]) {
    const refused = new Element();

    verity.presentConnections(refused, bad);
    assert.match(refused.textContent, /Unavailable/);
  }

  assert.deepEqual(asked, []);
});

test('one account on several records is one card, and counts once', async () => {
  const { verity, cards } = await groupHarness({});

  const gist = {
    by: 'provider',
    method: 'gist',
    artifactUrl: 'https://gist.github.com/a/1',
    confirmedAt: Date.now(),
  };

  const same = {
    external: { id: 'gh-1', handle: 'alice', profileUrl: 'https://github.com/alice' },
  };

  const host = new Element();

  verity.presentConnections(host, [
    // The same GitHub account three times over: revoked once, connected again by signing
    // in, and since shown a second way on a record of its own.
    linked('old', 'alice', 100, { ...same, status: 'revoked', revokedAt: 150 }),
    linked('again', 'alice', 200, same),
    linked('proof', 'alice', 300, {
      ...same,
      attestations: {
        local: { by: 'backend', method: 'declared', confirmedAt: 1 },
        external: [gist],
      },
    }),
    linked('other', 'bob', 250),
  ]);

  // Two accounts, not four records: the first connected leads, and there is one more.
  assert.equal(host.textContent, '@alice+1');

  const opened = await cards(host);

  assert.deepEqual(
    opened.cards.slice(1).map((card) => card.textContent.match(/@(alice|bob|carol|dave)/)![1]),
    ['alice', 'bob'],
  );

  // The account's card reads as verified, with both ways it is shown, and nothing of the
  // record it replaced.
  const card = opened.cards[1]!.textContent;

  assert.match(card, /Verified/);
  assert.match(card, /Signed in with GitHub/);
  assert.match(card, /\+ Published a proof on GitHub/);
  assert.ok(!card.includes('Revoked'));

  // An account with nothing verified is one card too, saying what last became of it.
  const lapsed = await groupHarness({});
  const none = new Element();

  lapsed.verity.presentConnections(none, [
    linked('first', 'alice', 100, { ...same, status: 'expired', expiresAt: 1, approvedAt: 100 }),
    linked('second', 'alice', 200, { ...same, status: 'revoked', revokedAt: 250, approvedAt: 200 }),
  ]);

  assert.match(none.textContent, /^@aliceRevoked$/);
  assert.equal((await lapsed.cards(none)).cards.length, 2);

  // Two different accounts with one provider stay two cards.
  const two = await groupHarness({});
  const pair = new Element();

  two.verity.presentConnections(pair, [linked('a', 'alice', 100), linked('b', 'bob', 200)]);
  assert.equal(pair.textContent, '@alice+1');
  assert.equal((await two.cards(pair)).cards.length, 3);
});

test('new records that leave the pill unchanged still open in the dialog', async () => {
  const { verity, cards } = await groupHarness({});
  const host = new Element();

  verity.presentConnections(host, [linked('a', 'alice', 100), linked('b', 'bob', 200)]);
  assert.equal(host.textContent, '@alice+1');

  // Bob is gone and Carol is there in his place: the same account leads, with one more.
  verity.presentConnections(host, [linked('a', 'alice', 100), linked('c', 'carol', 300)]);
  assert.equal(host.textContent, '@alice+1');

  // The dialog opens on the new records and is still on them after its first check.
  const opened = await cards(host);

  assert.deepEqual(
    opened.cards.slice(1).map((card) => card.textContent.match(/@(alice|bob|carol|dave)/)![1]),
    ['alice', 'carol'],
  );
});

test('connections set on a badge before its script has run are still presented', async () => {
  const { defined } = await groupHarness({});

  const Badge = defined['verity-badge']! as unknown as new () => Element & {
    connectedCallback(): void;
    connections: unknown;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const badge = new Badge();

  // What a page leaves behind by assigning before the element is upgraded: a property of
  // the element itself, in front of the class's own.
  Object.defineProperty(badge, 'connections', {
    value: [linked('a', 'alice', 100, { visibility: 'unlisted' })],
    writable: true,
    enumerable: true,
    configurable: true,
  });

  badge.connectedCallback();
  await settle();
  assert.equal(badge.textContent, '@alice');

  // And a later assignment reaches the badge, which it could not while the first hid it.
  badge.connections = [
    linked('a', 'alice', 100, { visibility: 'unlisted' }),
    linked('b', 'bob', 200, { visibility: 'unlisted' }),
  ];

  await settle();
  assert.equal(badge.textContent, '@alice+1');
});

test('evidence set on a badge before its script has run seeds its first paint', async () => {
  // The fetch never answers, so only the evidence handed over can have drawn the pill.
  const { upgrade } = await groupHarness({}, () => new Promise(() => {}));

  const badge = upgrade('verity-badge', { evidence: linked('a', 'alice', 100) }) as Element & {
    connectedCallback(): void;
  };

  badge.attributes['backend-url'] = 'https://verity.test';
  badge.attributes['connection-id'] = 'a';
  badge.connectedCallback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(badge.textContent, '@alice');
});

test('a badge that goes from one record to several opens its dialog on all of them', async () => {
  const gist = {
    by: 'provider',
    method: 'gist',
    artifactUrl: 'https://gist.github.com/a/1',
    confirmedAt: Date.now(),
  };

  const { verity, cards } = await groupHarness({
    a: linked('a', 'alice', 100),
    lapsed: linked('lapsed', 'bob', 200, { status: 'expired', expiresAt: 1 }),
    again: linked('again', 'alice', 300, {
      external: { id: 'ext-a', handle: 'alice', profileUrl: 'https://github.com/alice' },
      attestations: {
        local: { by: 'backend', method: 'declared', confirmedAt: 1 },
        external: [gist],
      },
    }),
  });

  const client = verity.init({ backendUrl: 'https://verifier.test/api/verity' });
  const host = new Element();

  await client.mountBadges(host, { connectionIds: ['a'] });
  assert.equal(host.textContent, '@alice');

  // A lapsed account and a second record of the first: neither changes the pill.
  await client.mountBadges(host, { connectionIds: ['a', 'lapsed', 'again'] });
  assert.equal(host.textContent, '@alice');

  const opened = await cards(host);

  assert.equal(opened.cards.length, 3);
  assert.match(opened.cards[1]!.textContent, /\+ Published a proof on GitHub/);
  assert.match(opened.cards[2]!.textContent, /@bob.*Expired/s);

  // And back to one: the dialog follows that too.
  const back = await groupHarness({
    a: linked('a', 'alice', 100),
    b: linked('b', 'bob', 200, { status: 'expired', expiresAt: 1 }),
  });

  const other = new Element();
  const again = back.verity.init({ backendUrl: 'https://verifier.test/api/verity' });

  await again.mountBadges(other, { connectionIds: ['a', 'b'] });
  await again.mountBadges(other, { connectionIds: ['a'] });
  assert.equal((await back.cards(other)).cards.length, 2);
});

test('records taken away while the dialog is open stop being shown in it', async () => {
  const { verity, cards, polls } = await groupHarness({});
  const host = new Element();

  verity.presentConnections(host, [linked('a', 'alice', 100), linked('b', 'bob', 200)]);

  const opened = await cards(host);

  assert.equal(opened.cards.length, 3);

  // The page clears them. The pill says so at once, and the dialog on its next check.
  verity.presentConnections(host, []);
  assert.match(host.textContent, /Unavailable/);

  for (const poll of polls) poll();

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(opened.dialog.textContent, /Verification unavailable/);
  assert.ok(!opened.dialog.textContent.includes('@alice'));
});

test('each account in an open dialog lapses at its own deadline', async () => {
  const { verity, cards } = await groupHarness({});
  const host = new Element();
  const soon = Date.now();

  verity.presentConnections(host, [
    linked('a', 'alice', 100, { expiresAt: soon + 60 }),
    linked('b', 'bob', 200, { expiresAt: soon + 140 }),
    linked('c', 'carol', 300),
  ]);

  const opened = await cards(host);

  const states = () =>
    opened.dialog
      .all()
      .filter((e) => e.className === 'state')
      .map((e) => e.textContent);

  assert.deepEqual(states(), ['Verified', 'Verified', 'Verified']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(states(), ['Expired', 'Verified', 'Verified']);

  // The second deadline is watched too, without waiting for the next check.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(states(), ['Expired', 'Expired', 'Verified']);
});

test('an account whose leading record runs out is taken up by another of its records', async () => {
  const { verity, cards } = await groupHarness({});
  const host = new Element();

  const same = {
    external: { id: 'gh-1', handle: 'alice', profileUrl: 'https://github.com/alice' },
  };

  const gist = {
    by: 'provider',
    method: 'gist',
    artifactUrl: 'https://gist.github.com/a/1',
    confirmedAt: Date.now(),
  };

  verity.presentConnections(host, [
    // One account on two records. The earlier one speaks for it, and runs out first.
    linked('early', 'alice', 100, { ...same, expiresAt: Date.now() + 60 }),
    linked('later', 'alice', 200, {
      ...same,
      attestations: {
        local: { by: 'backend', method: 'declared', confirmedAt: 1 },
        external: [gist],
      },
    }),
  ]);

  const opened = await cards(host);

  const card = () =>
    opened.dialog.all().filter((found) => found.className.includes('account'))[1]!.textContent;

  assert.equal(opened.cards.length, 2);
  assert.match(card(), /Verified/);
  assert.match(card(), /Signed in with GitHub/);

  // Past the first record's deadline, with no check in between: still one card, still
  // verified, now on the record that is.
  await new Promise((resolve) => setTimeout(resolve, 110));

  assert.equal(
    opened.dialog.all().filter((found) => found.className.includes('account')).length,
    2,
  );

  assert.match(card(), /Verified/);
  assert.ok(!card().includes('Expired'));
  assert.match(card(), /Published a proof on GitHub/);
  assert.ok(!card().includes('Signed in with GitHub'));
});

test('a badge whose connection ids are cleared stops its open dialog showing them', async () => {
  const { defined, cards, polls } = await groupHarness({
    a: linked('a', 'alice', 100),
    b: linked('b', 'bob', 200),
  });

  const Badge = defined['verity-badge']! as unknown as new () => Element & {
    connectedCallback(): void;
    attributeChangedCallback(): void;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const badge = new Badge();

  badge.setAttribute('backend-url', 'https://verifier.test/api/verity');
  badge.setAttribute('connection-ids', 'a b');
  badge.connectedCallback();
  await settle();
  assert.equal(badge.textContent, '@alice+1');

  const opened = await cards(badge);

  assert.equal(opened.cards.length, 3);

  // The page names no connections any more.
  badge.removeAttribute('connection-ids');
  badge.attributeChangedCallback();
  await settle();

  for (const poll of polls) poll();

  await settle();
  assert.match(opened.dialog.textContent, /Verification unavailable/);
  assert.ok(!opened.dialog.textContent.includes('@alice'));
});

test('a read that finishes after the host has moved on changes nothing', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const { verity, cards, defined } = await groupHarness(
    { a: linked('a', 'alice', 100), b: linked('b', 'bob', 200) },
    () => gate,
  );

  const client = verity.init({ backendUrl: 'https://verifier.test/api/verity' });

  // Records handed over while a fetch for other ones is still out.
  const replaced = new Element();
  const slow = client.mountBadges(replaced, { connectionIds: ['a', 'b'] });

  verity.presentConnections(replaced, [linked('c', 'carol', 300, { visibility: 'unlisted' })]);
  assert.equal(replaced.textContent, '@carol');

  // A fetch that will fail, overtaken the same way: its failure is not this host's either.
  const failing = new Element();
  const doomed = client.mountBadges(failing, { connectionIds: ['missing', 'gone'] });

  verity.presentConnections(failing, [linked('d', 'dave', 400, { visibility: 'unlisted' })]);

  // The ids cleared from a badge while its fetch is out.
  const Badge = defined['verity-badge']! as unknown as new () => Element & {
    connectedCallback(): void;
    attributeChangedCallback(): void;
  };

  const cleared = new Badge();

  cleared.setAttribute('backend-url', 'https://verifier.test/api/verity');
  cleared.setAttribute('connection-ids', 'a b');
  cleared.connectedCallback();
  await settle();
  cleared.removeAttribute('connection-ids');
  cleared.attributeChangedCallback();
  await settle();

  release();
  await Promise.all([slow, doomed]);
  await settle();

  assert.equal(replaced.textContent, '@carol');
  assert.equal(failing.textContent, '@dave');
  assert.ok(!cleared.textContent.includes('@alice'));
  assert.ok(!cleared.textContent.includes('Unavailable'));

  // The dialog is on the newer records as well, and stays on them.
  const opened = await cards(replaced);

  assert.equal(opened.cards.length, 2);
  assert.match(opened.cards[1]!.textContent, /@carol/);
});

test('an open dialog does not show a read the host moved on from while it was out', async () => {
  let gate: Promise<void> | undefined;
  let release!: () => void;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const { verity, cards, polls } = await groupHarness(
    { a: linked('a', 'alice', 100), b: linked('b', 'bob', 200) },
    () => gate ?? Promise.resolve(),
  );

  const host = new Element();

  await verity
    .init({ backendUrl: 'https://verifier.test/api/verity' })
    .mountBadges(host, { connectionIds: ['a', 'b'] });

  const opened = await cards(host);

  assert.equal(opened.cards.length, 3);

  // The dialog's periodic check goes out, and is still out when the page hands the host
  // different records.
  gate = new Promise<void>((resolve) => (release = resolve));

  for (const poll of polls) poll();

  await settle();
  verity.presentConnections(host, [linked('c', 'carol', 300, { visibility: 'unlisted' })]);
  release();
  gate = undefined;
  await settle();
  await settle();

  const shown = opened.dialog.all().filter((found) => found.className.includes('account'));

  assert.equal(shown.length, 2);
  assert.match(shown[1]!.textContent, /@carol/);
  assert.ok(!opened.dialog.textContent.includes('@bob'));
});
