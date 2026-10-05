import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { nodeHandler } from '@bkazemi/verily';
import { createTenant } from './tenant.js';

// A demonstration site registered with a public instance. The instance's SITES entry names
// this origin, `${ORIGIN}/verily/authorize` and `${ORIGIN}/verily/return`.
const origin = process.env.ORIGIN ?? 'http://localhost:3001';
const key = process.env.TENANT_KEY;

if (!key || !/^[A-Za-z0-9_-]{43,}$/.test(key))
  throw new Error('Set TENANT_KEY to the key the instance holds for this site');

const tenant = createTenant({
  origin,
  instance: process.env.INSTANCE ?? 'https://verily.shirkadeh.org',
  site: process.env.TENANT_SITE ?? 'demo',
  key,
  name: process.env.TENANT_NAME ?? 'Verily demo',
  script: await readFile(
    createRequire(import.meta.url).resolve('@bkazemi/verily/verily.js'),
    'utf8',
  ),
});

createServer(nodeHandler(tenant.handle, origin)).listen(new URL(origin).port || 3001, () =>
  console.log(`Demo tenant listening on ${origin}`),
);
