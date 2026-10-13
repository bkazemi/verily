import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudflareStarter } from './starter.js';

/**
 * Writes the Cloudflare starter into a directory, all of it or none. If any of its files
 * is already there, nothing is written. If a write fails partway, the files this call
 * made are removed, so a second try starts from the same place.
 */
export async function init(directory: string): Promise<void> {
  const files = Object.entries(cloudflareStarter).map(
    ([name, text]) => [join(directory, name), text] as const,
  );

  await mkdir(directory, { recursive: true });

  for (const [path] of files)
    if (await stat(path).catch(() => undefined))
      throw new Error(`${path} already exists. Nothing was written.`);

  const made: string[] = [];

  try {
    for (const [path, text] of files) {
      // `wx` fails on a file that appeared since the check, so it is never overwritten.
      await writeFile(path, text, { flag: 'wx' });
      made.push(path);
    }
  } catch (error) {
    for (const path of made) await rm(path, { force: true });

    throw error;
  }
}
