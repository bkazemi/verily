import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordProvider } from '../src/server/discord.js';

test('Discord adapter sends PKCE and reads identity from authenticated provider API', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];

  const provider = discordProvider({
    clientId: 'client',
    clientSecret: 'private-secret',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });

      return Response.json(
        calls.length === 1
          ? { access_token: 'private-token', token_type: 'Bearer' }
          : { id: '80351110224678912', username: 'alice', discriminator: '0' },
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

  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.equal(url.searchParams.has('client_secret'), false);

  assert.deepEqual(
    await provider.authenticate({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'https://site.test/callback',
    }),
    {
      id: '80351110224678912',
      handle: 'alice',
      profileUrl: 'https://discord.com/users/80351110224678912',
    },
  );

  const body = calls[0]!.init!.body as URLSearchParams;

  assert.equal(calls[0]!.url, 'https://discord.com/api/oauth2/token');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), 'verifier');
  assert.equal(body.get('redirect_uri'), 'https://site.test/callback');
  assert.equal(calls[1]!.url, 'https://discord.com/api/v10/users/@me');
  assert.equal(new Headers(calls[1]!.init!.headers).get('authorization'), 'Bearer private-token');
});

test('malformed Discord identity and token errors fail closed', async () => {
  for (const value of [
    { error: 'invalid_grant' },
    { id: 80351110224678912, username: 'alice', discriminator: '0' },
    { id: '0', username: 'alice', discriminator: '0' },
    { id: '80351110224678912', username: '<script>', discriminator: '0' },
    { id: '80351110224678912', username: 'Alice', discriminator: '0' },
    { id: '80351110224678912', username: 'alice', discriminator: '1234' },
  ]) {
    let calls = 0;

    const provider = discordProvider({
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

test('Discord adapter requires credentials', () => {
  assert.throws(() => discordProvider({ clientId: '', clientSecret: 'secret' }));
  assert.throws(() => discordProvider({ clientId: 'client', clientSecret: '' }));
});
