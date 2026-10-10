import { cp, mkdir } from 'node:fs/promises';

const frontend = new URL('../build/webclient/frontend/', import.meta.url);
await mkdir(frontend, { recursive: true });
for (const name of ['index.html', 'styles.css', 'sql-reference.json']) {
  await cp(new URL(`../src/webclient/frontend/${name}`, import.meta.url), new URL(name, frontend));
}

await cp(
  new URL('../hnsw-native/prebuilt/', import.meta.url),
  new URL('../build/indexes/hnsw/prebuilt/', import.meta.url),
  { recursive: true },
);
