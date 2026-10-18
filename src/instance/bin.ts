#!/usr/bin/env node
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { serve, type ServeEnv } from './serve.js';
import { init } from './init.js';
import { githubApp } from './github-app.js';

const usage = `Usage:
  verily serve                    Run an instance on Node, from the environment.
  verily init cloudflare [dir]    Write a Cloudflare project into dir.
  verily github-app <callback>... [--org <name>] [--name <name>]
                                  Create a GitHub App for sign-in, up to 10 callbacks.`;

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

/** Runs the manifest flow, then prints the app's credentials. */
async function createGithubApp(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { org: { type: 'string' }, name: { type: 'string' } },
  });

  const app = await githubApp({
    callbacks: positionals,
    org: values.org,
    name: values.name,
    onReady: (url) => console.log(`Open ${url} in a browser signed in to GitHub.`),
  });

  console.log(`Created ${app.htmlUrl}

GITHUB_CLIENT_ID=${app.clientId}
GITHUB_CLIENT_SECRET=${app.clientSecret}

Keep the secret on the server. GitHub shows it only this once.

To show a logo when people sign in, upload one under Display information at
${app.htmlUrl}`);
}

const [command, target, directory] = process.argv.slice(2);

try {
  if (command === 'serve') {
    const { server } = await serve(process.env as unknown as ServeEnv);
    const { address, port } = server.address() as AddressInfo;

    console.log(`Verily instance for ${process.env.PUBLIC_ORIGIN} listening on ${address}:${port}`);
  } else if (command === 'init' && target === 'cloudflare') {
    await start(directory ?? '.');
  } else if (command === 'github-app') {
    await createGithubApp(process.argv.slice(3));
  } else {
    console.error(usage);
    process.exit(command === undefined || command === '--help' || command === '-h' ? 0 : 2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
