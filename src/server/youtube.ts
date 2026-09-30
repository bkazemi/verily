import { Refused, type RedirectProvider } from '../core/index.js';

/**
 * Google OAuth client, PKCE S256, `youtube.readonly` scope only. The account proved is the
 * YouTube channel chosen at consent, not the Google account behind it. Tokens are revoked
 * as soon as the channel is read and are never persisted.
 */
export function youtubeProvider(options: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): RedirectProvider {
  if (!options.clientId || !options.clientSecret) throw new Error('Google credentials required');

  const request = options.fetch ?? fetch;

  return {
    id: 'youtube',
    name: 'YouTube',
    method: 'oauth',
    authorizationUrl({ state, challenge, redirectUri }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');

      // select_account lets a holder with several Google accounts, or a channel under a
      // brand account, pick the one they mean rather than whichever is signed in.
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
        access_type: 'online',
        prompt: 'select_account',
      }).toString();

      return url.href;
    },
    async authenticate({ code, verifier, redirectUri }) {
      const response = await request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });

      const token: unknown = await response.json();

      if (!response.ok || !isRecord(token) || typeof token.access_token !== 'string' || token.error)
        throw new Error('Provider authentication failed');

      const accessToken = token.access_token;

      try {
        const identity = await request(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          },
        );

        const body: unknown = await identity.json();

        if (!identity.ok || !isRecord(body)) throw new Error('Invalid provider identity');

        // A Google account that has never created a channel signs in fine but has nothing
        // to link, which is the holder's to fix, so it is said rather than hidden.
        if (!Array.isArray(body.items) || body.items.length === 0)
          throw new Refused('This Google account has no YouTube channel');

        const channel: unknown = body.items[0];

        if (
          body.items.length !== 1 ||
          !isRecord(channel) ||
          typeof channel.id !== 'string' ||
          !/^UC[A-Za-z0-9_-]{22}$/.test(channel.id) ||
          !isRecord(channel.snippet)
        )
          throw new Error('Invalid provider identity');

        // The handle is the @name. The channel id is the stable identity: handles can be
        // changed and then claimed by another channel.
        const customUrl = channel.snippet.customUrl;

        if (customUrl === undefined) throw new Refused('This YouTube channel has no handle');

        const handle =
          typeof customUrl === 'string'
            ? /^@?([\p{L}\p{M}\p{N}._·-]{3,30})$/u.exec(customUrl)?.[1]
            : undefined;

        if (!handle) throw new Error('Invalid provider identity');

        return {
          id: channel.id,
          handle,
          profileUrl: `https://www.youtube.com/channel/${channel.id}`,
        };
      } finally {
        // The scope reads the whole YouTube account for an hour. Nothing more is needed
        // from it, so it is given back now rather than left to expire.
        await request('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          body: new URLSearchParams({ token: accessToken }),
        }).catch(() => undefined);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
