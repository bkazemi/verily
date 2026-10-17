// Writes each src/**/*.css next to itself as a .css.ts module that exports its text, so
// tsc, tsx, esbuild and wrangler can all import a stylesheet as a string. The .css.ts
// files are generated and ignored by git; edit the .css files.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('src', { recursive: true, withFileTypes: true }).filter(
  (entry) => entry.isFile() && entry.name.endsWith('.css'),
);

for (const file of files) {
  const path = join(file.parentPath, file.name);
  const text = readFileSync(path, 'utf8');
  const module = `// Generated from ${file.name} by scripts/css.mjs. Do not edit.\nexport default ${JSON.stringify(text)};\n`;

  // Unchanged output is left alone, so a watcher does not see a change that is not there.
  let current = '';

  try {
    current = readFileSync(`${path}.ts`, 'utf8');
  } catch {}

  if (current !== module) writeFileSync(`${path}.ts`, module);
}
