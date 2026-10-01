import { build } from 'esbuild';

/** Bundles the test entry the way wrangler bundles the worker. */
export async function buildWorker(outfile: string) {
  await build({
    entryPoints: ['tests/fixtures/cloudflare.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    // What wrangler resolves a package by: its export conditions, or where it ships no
    // `exports` of its own, these fields.
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['node:*'],
    alias: { undici: './cloudflare/undici.ts' },
    outfile,
  });
}
