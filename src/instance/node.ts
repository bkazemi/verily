import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Instance } from './index.js';

/** The instance's own bound on a body. A larger one is refused before it is buffered. */
const maxBodyBytes = 65536;

export interface ListenerOptions {
  /** The origin the instance is served from, as given to `createInstance`. */
  origin: string;
  /**
   * The client's address, which rate limits count by. The socket's by default. Behind a
   * proxy every request comes from the proxy, so read the header that proxy sets instead.
   */
  address?(request: IncomingMessage): string | null;
}

/** Serves an instance from `node:http`: `createServer(nodeListener(instance, { origin }))`. */
export function nodeListener(instance: Pick<Instance, 'handle'>, options: ListenerOptions) {
  const address = options.address ?? ((request) => request.socket.remoteAddress ?? null);

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;

      for await (const chunk of req) {
        length += chunk.length;

        if (length > maxBodyBytes) {
          res.writeHead(413, { 'Cache-Control': 'no-store' });
          res.end();

          return;
        }

        chunks.push(Buffer.from(chunk));
      }

      const headers = new Headers();

      for (const [key, value] of Object.entries(req.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);

      const response = await instance.handle(
        new Request(new URL(req.url ?? '/', options.origin), {
          method: req.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
        address(req),
      );

      // Each cookie is a header of its own: joined into one, a browser keeps only the first.
      const cookies = response.headers.getSetCookie();

      response.headers.delete('Set-Cookie');

      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
      });

      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });

      res.end('Request failed');
    }
  };
}
