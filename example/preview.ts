import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Evidence } from '@bkazemi/verily';

const require = createRequire(import.meta.url);
const asset = await readFile(require.resolve('@bkazemi/verily/verily.js'));
const page = await readFile(new URL('./preview.html', import.meta.url));
const port = Number(process.env.PREVIEW_PORT ?? 3001);
const origin = `http://localhost:${port}`;

/**
 * Extra accounts of the same subject, each a sign-in, so one tile has more of them than
 * a stacked badge has rows for.
 */
const extra: Record<
  string,
  {
    provider: string;
    providerName: string;
    handle: string;
    /** How the holder lists the account, or that they retired it. */
    mark?: 'preferred' | 'unused';
    retired?: true;
  }
> = {
  discord: { provider: 'discord', providerName: 'Discord', handle: 'joe' },
  youtube: { provider: 'youtube', providerName: 'YouTube', handle: 'joemarshall' },
  work: { provider: 'github', providerName: 'GitHub', handle: 'joe-at-work' },
  // The last connected and the one its holder leads with, an account still held and no
  // longer used, and one that is finished and kept as history.
  preferred: { provider: 'github', providerName: 'GitHub', handle: 'joe-main', mark: 'preferred' },
  unused: { provider: 'discord', providerName: 'Discord', handle: 'joe-old', mark: 'unused' },
  retired: { provider: 'github', providerName: 'GitHub', handle: 'joe-2019', retired: true },
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', origin);

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname === '/assets/verily.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(asset);

    return;
  }

  // The proof a key-signed connection points at, served as the text a reader would check.
  if (url.pathname === '/api/verily/connections/signed/proof') {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');

    response.end(
      `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nVerily proof for JoeSite: 9Qv2bXkP\n-----BEGIN PGP SIGNATURE-----\n\n(demo: not a real signature)\n-----END PGP SIGNATURE-----\n`,
    );

    return;
  }

  if (url.pathname.startsWith('/api/verily/connections/')) {
    const id = url.pathname.split('/').at(-1)!;

    if (
      !['current', 'signed-in', 'signed', 'mailed', 'unconfirmed', 'expired', 'revoked'].includes(
        id,
      ) &&
      !extra[id]
    ) {
      response.writeHead(404);
      response.end('Unavailable');

      return;
    }

    // A published proof only holds while it is still published, so one tile shows a
    // connection whose proof has gone unread: inside its approval, outside its freshness.
    const proof = {
      by: 'provider' as const,
      method: 'gist' as const,
      artifactUrl: 'https://gist.github.com/joe/3f8a1c9e2b7d4506a1f2',
      expect: 'Verily proof for JoeSite: 9Qv2bXkP',
      confirmedAt: Date.now() - (id === 'unconfirmed' ? 9 * 86400000 : 3600000),
    };

    // A key proves itself, so the proof is held here rather than read somewhere else, and
    // it is addressed by the connection it belongs to.
    const signature = {
      by: 'provider' as const,
      method: 'signature' as const,
      artifactUrl: `${origin}/api/verily/connections/${id}/proof`,
      expect: 'Verily proof for JoeSite: 9Qv2bXkP',
      hosted: true,
      confirmedAt: Date.now() - 3600000,
    };

    const evidence: Evidence = {
      id,
      local: { label: 'Joe', reference: 'joesite-member-1' },
      external:
        id === 'signed'
          ? {
              id: '05975AC2F819C57438C06248E7E21D206C283B44',
              kind: 'key',
              handle: 'joe@joesite.example',
              profileUrl: `${origin}/demo`,
            }
          : id === 'mailed'
            ? {
                id: 'joe@joesite.example',
                kind: 'mailbox',
                handle: 'joe@joesite.example',
                profileUrl: 'mailto:joe@joesite.example',
              }
            : extra[id]
              ? { id: `demo-${id}`, handle: extra[id].handle, profileUrl: `${origin}/demo` }
              : { id: 'demo-account', handle: 'Joe', profileUrl: `${origin}/demo` },
      provider:
        extra[id]?.provider ?? (id === 'signed' ? 'openpgp' : id === 'mailed' ? 'email' : 'github'),
      providerName:
        extra[id]?.providerName ??
        (id === 'signed' ? 'OpenPGP' : id === 'mailed' ? 'Email' : 'GitHub'),
      siteName: 'JoeSite',
      verifierName: 'JoeSite',
      visibility: 'public',
      status: extra[id]?.retired
        ? 'retired'
        : ['current', 'signed-in', 'signed', 'mailed', ...Object.keys(extra)].includes(id)
          ? 'verified'
          : id === 'revoked'
            ? 'revoked'
            : id === 'unconfirmed'
              ? 'unconfirmed'
              : 'expired',
      // Each was first connected on a different day, though all were renewed yesterday:
      // the tile showing several as one pill orders them by this.
      connectedAt:
        Date.now() -
        86400000 *
          ({ 'signed-in': 30, current: 20, signed: 10, mailed: 5, discord: 4, youtube: 3, work: 2 }[
            id
          ] ?? 40),
      // The retired account was last proved long before its holder retired it.
      authenticatedAt: Date.now() - 86400000 * (extra[id]?.retired ? 200 : 1),
      approvedAt: Date.now() - 86400000 * (extra[id]?.retired ? 200 : 1),
      visibilityApprovedAt: Date.now() - 86400000,
      expiresAt:
        ['expired', 'revoked'].includes(id) || extra[id]?.retired
          ? Date.now() - 1000
          : Date.now() + 86400000,
      ...(extra[id]?.mark ? { mark: extra[id].mark } : {}),
      ...(extra[id]?.retired ? { retiredAt: Date.now() - 86400000 * 150 } : {}),
      evidenceUrl: `${origin}/demo`,
      // One record from a verifier that signs, so its card shows that it is signed.
      ...(id === 'current' ? { signedUrl: `${origin}/demo?format=signed` } : {}),
      attestations: {
        // The site is the only authority on its own namespace, so it states this side.
        local: { by: 'backend', method: 'declared', confirmedAt: Date.now() - 86400000 },
        // The same pair proved two ways, so the preview shows both: a gist anyone can
        // open and check, and a sign-in that publishes nothing.
        // The signed-in pair was later shown a second way too, so it lists that after.
        external:
          id === 'signed'
            ? [signature]
            : id === 'mailed'
              ? // A mailed link or code, which like a sign-in publishes nothing.
                [{ by: 'provider', method: 'code', confirmedAt: Date.now() - 86400000 }]
              : ['current', 'unconfirmed'].includes(id)
                ? [proof]
                : [
                    { by: 'provider', method: 'oauth', confirmedAt: Date.now() - 86400000 },
                    ...(id === 'signed-in'
                      ? [
                          {
                            by: 'provider' as const,
                            method: 'backlink' as const,
                            artifactUrl: `${origin}/demo`,
                            expect: 'https://joesite.example/joe',
                            confirmedAt: Date.now() - 3600000,
                          },
                        ]
                      : []),
                  ],
      },
    };

    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(evidence));

    return;
  }

  response.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (url.pathname === '/demo') {
    response.end(
      '<h1>Demo: simulated verification</h1><p>This preview uses fixtures. Run the full example with GitHub credentials for real verification.</p><a href="/">Back to preview</a>',
    );

    return;
  }

  response.end(page);
});

server.listen(port, '127.0.0.1', () => console.log(`Verily component preview: ${origin}`));

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
