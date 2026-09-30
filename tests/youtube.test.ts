import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Refused } from '../src/core/index.js';
import { youtubeProvider } from '../src/server/youtube.js';

const channelId = 'UCBR8-60-B28hp2BmDPdntcQ';

function provider(channels: unknown, calls: { url: string; init?: RequestInit }[] = []) {
  return youtubeProvider({
    clientId: 'client',
    clientSecret: 'private-secret',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });

      if (String(url).startsWith('https://oauth2.googleapis.com/token'))
        return Response.json({ access_token: 'private-token', token_type: 'Bearer' });

      if (String(url).startsWith('https://oauth2.googleapis.com/revoke'))
        return new Response(null, { status: 200 });

      return Response.json(channels);
    }) as typeof fetch,
  });
}

const input = { code: 'code', verifier: 'verifier', redirectUri: 'https://site.test/callback' };

test('YouTube adapter sends PKCE, reads the chosen channel and revokes the token', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];

  const youtube = provider(
    { items: [{ id: channelId, snippet: { title: 'Alice Trades', customUrl: '@alicetrades' } }] },
    calls,
  );

  const url = new URL(
    youtube.authorizationUrl({ state: 'state', challenge: 'challenge', ...input }),
  );

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.readonly');
  assert.equal(url.searchParams.get('access_type'), 'online');
  assert.equal(url.searchParams.has('client_secret'), false);

  assert.deepEqual(await youtube.authenticate(input), {
    id: channelId,
    handle: 'alicetrades',
    profileUrl: `https://www.youtube.com/channel/${channelId}`,
  });

  assert.equal((calls[0]!.init!.body as URLSearchParams).get('code_verifier'), 'verifier');

  assert.equal(
    calls[1]!.url,
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
  );

  assert.equal(new Headers(calls[1]!.init!.headers).get('authorization'), 'Bearer private-token');
  assert.equal(calls[2]!.url, 'https://oauth2.googleapis.com/revoke');
  assert.equal((calls[2]!.init!.body as URLSearchParams).get('token'), 'private-token');
});

test('a handle in another script is kept as written', async () => {
  const youtube = provider({ items: [{ id: channelId, snippet: { customUrl: '@トレーダー' } }] });

  assert.equal((await youtube.authenticate(input)).handle, 'トレーダー');
});

test('a Google account with no channel, or a channel with no handle, is told why', async () => {
  for (const [channels, reason] of [
    [{ items: [] }, 'This Google account has no YouTube channel'],
    [{}, 'This Google account has no YouTube channel'],
    [
      { items: [{ id: channelId, snippet: { title: 'Alice' } }] },
      'This YouTube channel has no handle',
    ],
  ] as const) {
    const calls: { url: string }[] = [];

    await assert.rejects(provider(channels, calls).authenticate(input), (error) => {
      assert.ok(error instanceof Refused);
      assert.equal(error.message, reason);

      return true;
    });

    assert.equal(calls.at(-1)!.url, 'https://oauth2.googleapis.com/revoke');
  }
});

test('malformed YouTube identity and token errors fail closed', async () => {
  for (const channels of [
    { items: [{ id: 'not-a-channel', snippet: { customUrl: '@alice' } }] },
    { items: [{ id: channelId, snippet: { customUrl: '@<script>' } }] },
    { items: [{ id: channelId }] },
    {
      items: [
        { id: channelId, snippet: { customUrl: '@alice' } },
        { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', snippet: { customUrl: '@bob' } },
      ],
    },
  ])
    await assert.rejects(provider(channels).authenticate(input));

  const failing = youtubeProvider({
    clientId: 'client',
    clientSecret: 'secret',
    fetch: (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch,
  });

  await assert.rejects(failing.authenticate(input), /Provider authentication failed/);
});

test('YouTube adapter requires credentials', () => {
  assert.throws(() => youtubeProvider({ clientId: '', clientSecret: 'secret' }));
  assert.throws(() => youtubeProvider({ clientId: 'client', clientSecret: '' }));
});
