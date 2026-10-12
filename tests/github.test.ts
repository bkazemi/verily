import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubProvider } from '../src/server/github.js';

test('GitHub adapter sends PKCE and reads identity from authenticated provider API', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];

  const provider = githubProvider({
    clientId: 'client',
    clientSecret: 'private-secret',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });

      return Response.json(
        calls.length === 1
          ? { access_token: 'private-token' }
          : { id: 42, login: 'alice', created_at: '2014-03-02T10:20:30Z' },
      );
    }) as typeof fetch,
  });

  const url = new URL(
    provider.authorizationUrl({
      state: 'state',
      challenge: 'challenge',
      redirectUri: 'https://site.test/callback',
    }),
  );

  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), '');
  assert.equal(url.searchParams.has('client_secret'), false);

  assert.equal(url.searchParams.get('prompt'), 'select_account');

  // A flow on a record names its account, so the chooser is not forced a second time.
  const known = new URL(
    provider.authorizationUrl({
      state: 'state',
      challenge: 'challenge',
      redirectUri: 'https://site.test/callback',
      account: { id: '42', handle: 'alice', profileUrl: 'https://github.com/alice' },
    }),
  );

  assert.equal(known.searchParams.get('login'), 'alice');
  assert.equal(known.searchParams.has('prompt'), false);

  assert.deepEqual(
    await provider.authenticate({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'https://site.test/callback',
    }),
    {
      id: '42',
      handle: 'alice',
      profileUrl: 'https://github.com/alice',
      createdAt: Date.UTC(2014, 2, 2, 10, 20, 30),
    },
  );

  assert.equal((calls[0]!.init!.body as URLSearchParams).get('code_verifier'), 'verifier');
  assert.equal(new Headers(calls[1]!.init!.headers).get('authorization'), 'Bearer private-token');
});

test('malformed provider identity and token errors fail closed', async () => {
  for (const value of [
    { error: 'bad_verification_code' },
    { id: 'not-a-stable-id', login: 'alice' },
    { id: 42, login: '<script>' },
  ]) {
    let calls = 0;

    const provider = githubProvider({
      clientId: 'client',
      clientSecret: 'secret',
      fetch: (async () =>
        Response.json(
          ++calls === 1 && !('error' in value) ? { access_token: 'token' } : value,
        )) as typeof fetch,
    });

    await assert.rejects(
      provider.authenticate({
        code: 'code',
        verifier: 'verifier',
        redirectUri: 'https://site.test/callback',
      }),
    );
  }
});

test('a sign-in that does not say when the account was made is taken without a date', async () => {
  for (const created_at of [undefined, 42, 'long ago']) {
    let calls = 0;

    const provider = githubProvider({
      clientId: 'client',
      clientSecret: 'secret',
      fetch: (async () =>
        Response.json(
          ++calls === 1 ? { access_token: 'token' } : { id: 42, login: 'alice', created_at },
        )) as typeof fetch,
    });

    assert.deepEqual(
      await provider.authenticate({
        code: 'code',
        verifier: 'verifier',
        redirectUri: 'https://site.test/callback',
      }),
      { id: '42', handle: 'alice', profileUrl: 'https://github.com/alice' },
    );
  }
});
