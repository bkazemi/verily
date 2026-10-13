#!/usr/bin/env node
import type { AddressInfo } from 'node:net';
import { serve, type ServeEnv } from './serve.js';
import { init } from './init.js';

const usage = `Usage:
  verily serve                    Run an instance on Node, from the environment.
  verily init cloudflare [dir]    Write a Cloudflare project into dir.`;

/** Writes the starter, then says what to do with it. */
async function start(directory: string) {
  await init(directory);

  console.log(`Wrote a Cloudflare project to ${directory}

Next, in that directory:
  1. npm install
  2. Fill in account_id and the vars in wrangler.jsonc.
  3. npx wrangler secret put OWNER_KEY
  4. npm run deploy`);
}

const [command, target, directory] = process.argv.slice(2);

try {
  if (command === 'serve') {
    const { server } = await serve(process.env as unknown as ServeEnv);
    const { address, port } = server.address() as AddressInfo;

    console.log(`Verily instance for ${process.env.PUBLIC_ORIGIN} listening on ${address}:${port}`);
  } else if (command === 'init' && target === 'cloudflare') {
    await start(directory ?? '.');
  } else {
    console.error(usage);
    process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
