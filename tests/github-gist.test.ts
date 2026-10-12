import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Absent } from '../src/core/index.js';
import { githubGistProvider } from '../src/server/github-gist.js';
import { written } from './helpers.js';

const expect = 'Verily proof for site.test: token';

function provider(gist: unknown, ok = true, status = ok ? 200 : 500) {
  const calls: string[] = [];

  const instance = githubGistProvider({
    fetch: ((url: string) => {
      calls.push(String(url));

      return Promise.resolve({ ok, status, json: () => Promise.resolve(gist) });
    }) as unknown as typeof fetch,
  });

  return { instance, calls };
}

const valid = {
  public: true,
  owner: { id: 42, login: 'alice' },
  files: { 'proof.md': { content: `hello\n${expect}\n` } },
};

test('a public gist containing the line identifies the account that published it', async () => {
  const { instance, calls } = provider(valid);

  assert.deepEqual(
    await instance.verify({
      artifact: 'https://gist.github.com/alice/0123456789abcdef01234567',
      expect,
    }),
    { id: '42', handle: 'alice', profileUrl: 'https://github.com/alice' },
  );

  // Read through the API by id, never by fetching the address the holder supplied.
  assert.deepEqual(calls, ['https://api.github.com/gists/0123456789abcdef01234567']);
  assert.match(written(instance.instructions(expect)), /public gist/);
  assert.ok(written(instance.instructions(expect)).includes(expect));

  // Where to publish is a link, so the holder does not have to type it.
  assert.deepEqual(instance.instructions(expect)[0], [
    'Publish this line in a public gist at ',
    { text: 'gist.github.com', href: 'https://gist.github.com/' },
    ', then paste the gist address below.',
  ]);
});

test('the holder cannot point the check at anything but a gist', async () => {
  for (const artifactUrl of [
    'https://evil.test/0123456789abcdef01234567',
    'http://gist.github.com/alice/0123456789abcdef01234567',
    'https://gist.github.com.evil.test/0123456789abcdef01234567',
    'https://gist.github.com/alice/../../etc',
    'https://gist.github.com/alice/not-a-gist-id',
    'https://gist.github.com/',
  ]) {
    const { instance, calls } = provider(valid);

    await assert.rejects(
      instance.verify({ artifact: artifactUrl, expect }),
      `accepted ${artifactUrl}`,
    );

    assert.deepEqual(calls, [], `fetched ${artifactUrl}`);
  }
});

test('a gist that does not prove the claim is refused', async () => {
  const url = 'https://gist.github.com/alice/0123456789abcdef01234567';

  const cases: [string, unknown][] = [
    // A secret gist proves nothing a reader could check for themselves.
    ['secret gist', { ...valid, public: false }],
    ['missing line', { ...valid, files: { 'a.md': { content: 'nothing here' } } }],
    // The part that would have matched may be the part that was cut.
    ['truncated file', { ...valid, files: { 'a.md': { content: expect, truncated: true } } }],
    ['no owner', { ...valid, owner: undefined }],
    ['anonymous gist', { ...valid, owner: { id: 0, login: 'alice' } }],
    ['invalid login', { ...valid, owner: { id: 42, login: 'alice/../bob' } }],
    ['no files', { ...valid, files: undefined }],
  ];

  for (const [name, gist] of cases) {
    const { instance } = provider(gist);

    await assert.rejects(instance.verify({ artifact: url, expect }), `accepted ${name}`);
  }

  // A deleted or rate-limited gist is a failure, never a pass.
  const { instance } = provider({ message: 'Not Found' }, false);

  await assert.rejects(instance.verify({ artifact: url, expect }));
});

test('a gist proving one flow does not prove another', async () => {
  const { instance } = provider(valid);

  await assert.rejects(
    instance.verify({
      artifact: 'https://gist.github.com/alice/0123456789abcdef01234567',
      expect: 'Verily proof for site.test: a different token',
    }),
  );
});

test('a gist that is gone is reported as missing, and a failed read is not', async () => {
  const artifact = 'https://gist.github.com/alice/0123456789abcdef01234567';

  const read = (gist: unknown, ok = true, status?: number) =>
    provider(gist, ok, status).instance.verify({ artifact, expect });

  const missing = (error: Error) => error instanceof Absent;

  await assert.rejects(read({}, false, 404), missing);
  await assert.rejects(read({ ...valid, public: false }), missing);
  await assert.rejects(read({ ...valid, files: { 'proof.md': { content: 'hello' } } }), missing);

  // A gist cut short may hold the line in the part left out, so it is a failed read.
  const cut = { 'proof.md': { content: 'hello', truncated: true } };

  await assert.rejects(read({ ...valid, files: cut }), (error: Error) => !missing(error));

  await assert.rejects(
    read({ ...valid, truncated: true, files: { 'a.md': { content: 'hello' } } }),
    (error: Error) => !missing(error),
  );

  // A server error or a rate limit says nothing about whether the gist is still there.
  await assert.rejects(read({}, false, 500), (error: Error) => !missing(error));
  await assert.rejects(read({}, false, 403), (error: Error) => !missing(error));
});
