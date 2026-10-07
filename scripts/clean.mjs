import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.resolve(root, 'build');
if (path.dirname(build) !== path.resolve(root)) throw new Error('Build directory must be inside the repository');
await rm(build, { recursive: true, force: true });
