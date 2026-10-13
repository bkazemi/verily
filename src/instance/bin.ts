#!/usr/bin/env node
import type { AddressInfo } from 'node:net';
import { serve, type ServeEnv } from './serve.js';

try {
  const { server } = await serve(process.env as unknown as ServeEnv);
  const { address, port } = server.address() as AddressInfo;

  console.log(`Verily instance for ${process.env.PUBLIC_ORIGIN} listening on ${address}:${port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
