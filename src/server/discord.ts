import type { RedirectProvider } from '../core/index.js';

/** Discord OAuth2 app, PKCE S256, `identify` scope only. Tokens are never persisted. */
export function discordProvider(options: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): RedirectProvider {
  if (!options.clientId || !options.clientSecret) throw new Error('Discord credentials required');

  const request = options.fetch ?? fetch;

  return {
    id: 'discord',
    name: 'Discord',
    method: 'oauth',
    authorizationUrl({ state, challenge, redirectUri }) {
      const url = new URL('https://discord.com/oauth2/authorize');

      // Discord has no account chooser. Forcing the consent screen at least shows the holder
      // which account they are signed in as before it is linked.
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'identify',
        prompt: 'consent',
      }).toString();

      return url.href;
    },
    async authenticate({ code, verifier, redirectUri }) {
      const response = await request('https://discord.com/api/oauth2/token', {
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

      const identity = await request('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      const user: unknown = await identity.json();

      // The snowflake is the stable id; usernames can be changed and then taken by someone
      // else. Only the current unique usernames are accepted: an account still on a legacy
      // name#1234 has a name that is not unique by itself and cannot be written as a handle.
      if (
        !identity.ok ||
        !isRecord(user) ||
        typeof user.id !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(user.id) ||
        typeof user.username !== 'string' ||
        !/^[a-z0-9_.]{2,32}$/.test(user.username) ||
        (user.discriminator !== undefined && user.discriminator !== '0')
      )
        throw new Error('Invalid provider identity');

      return {
        id: user.id,
        handle: user.username,
        profileUrl: `https://discord.com/users/${user.id}`,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
