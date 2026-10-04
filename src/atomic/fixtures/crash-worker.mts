// Adapt the WAL failpoints from feature/simpledbms/Server1 without patching
// production prototypes or carrying forward its obsolete interactive CLI.
import { join } from 'node:path';
import { AtomicFile } from '../atomicfile.mjs';
import { RealFile } from '../../core/file.mjs';

type Failpoint = 'before-log' | 'after-log' | 'during-data';
const [directory, failpoint] = process.argv.slice(2);
if (!directory || !['before-log', 'after-log', 'during-data'].includes(failpoint)) {
  throw new Error('Expected a temporary directory and a WAL failpoint');
}
let armed = false;

function crash(phase: Failpoint): void {
  if (armed && failpoint === phase) {
    console.error(`FAILPOINT:${phase}`);
    process.exit(86);
  }
}

class CrashFile extends RealFile {
  constructor(
    path: string,
    private readonly role: 'data' | 'log',
  ) {
    super(path);
  }

  override async writev(buffers: Buffer[], position: number): Promise<void> {
    if (this.role === 'log') crash('before-log');
    await super.writev(buffers, position);
    if (this.role === 'data') crash('during-data');
  }

  override async sync(): Promise<void> {
    await super.sync();
    if (this.role === 'log') crash('after-log');
  }
}

const atomic = new AtomicFile(
  new CrashFile(join(directory, 'data.bin'), 'data'),
  new CrashFile(join(directory, 'log.wal'), 'log'),
);
await atomic.open();
armed = true;
await atomic.atomicWrite(
  new Map([
    [0, Buffer.alloc(4096, 3)],
    [4096, Buffer.alloc(4096, 4)],
    [8192, Buffer.alloc(4096, 5)],
  ]),
);
throw new Error('Expected the configured failpoint to terminate this process');
