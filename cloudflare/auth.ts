import { timingSafeEqual } from 'node:crypto';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { expired } from '../src/core/index.js';
import { hash, secret } from '../src/server/service.js';

const sessionMs = 8 * 3600000;
// Use a normal host-only cookie name. Secure, HttpOnly, SameSite and Path=/
// provide the relevant protections while avoiding __Host-prefix rejection by
// browsers or privacy extensions on workers.dev.
const cookieName = 'verily_owner';

interface Session {
  expiresAt: number;
  keyHash: string;
}

export class OwnerAuth {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ownerKey: string,
  ) {
    if (!/^[A-Za-z0-9_-]{43,}$/.test(ownerKey))
      throw new Error(
        'OWNER_KEY must be a randomly generated base64url secret of at least 32 bytes',
      );
  }

  private token(request: Request) {
    return request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  }

  async authenticated(request: Request): Promise<boolean> {
    return (await this.session(request)) !== undefined;
  }

  /** Which owner session a request belongs to, by the hash its record is stored under. */
  async session(request: Request): Promise<string | undefined> {
    const token = this.token(request);

    if (!token) return undefined;

    const session = await this.storage.get<Session>(`owner/session/${hash(token)}`);

    return !!session && session.expiresAt > Date.now() && session.keyHash === hash(this.ownerKey)
      ? hash(token)
      : undefined;
  }

  async login(key: string): Promise<string | undefined> {
    if (!timingSafeEqual(Buffer.from(hash(key)), Buffer.from(hash(this.ownerKey)))) return;

    const token = secret();

    await this.storage.delete('owner/rate/v2/login');

    await this.storage.put<Session>(`owner/session/${hash(token)}`, {
      expiresAt: Date.now() + sessionMs,
      keyHash: hash(this.ownerKey),
    });

    return `${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionMs / 1000}`;
  }

  async logout(request: Request): Promise<string> {
    const token = this.token(request);

    if (token) await this.storage.delete(`owner/session/${hash(token)}`);

    return `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }

  async allow(bucket: 'login', limit: number, windowMs: number): Promise<boolean> {
    return this.storage.transaction(async (tx) => {
      const key = `owner/rate/v2/${bucket}`;
      const previous = await tx.get<{ count: number; until: number }>(key);

      const next =
        previous && previous.until > Date.now()
          ? previous
          : { count: 0, until: Date.now() + windowMs };

      if (next.count >= limit) return false;

      next.count++;
      await tx.put(key, next);

      return true;
    });
  }

  async prune(): Promise<void> {
    // One counter for every POST, from before requests were limited per session and client.
    await this.storage.delete('owner/rate/v2/mutation');

    await this.storage.transaction(async (tx) => {
      for (const [key, session] of await tx.list<Session>({ prefix: 'owner/session/' })) {
        if (expired(session, Date.now()) || session.keyHash !== hash(this.ownerKey))
          await tx.delete(key);
      }
    });
  }
}
