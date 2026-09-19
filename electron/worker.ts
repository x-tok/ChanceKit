import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppService } from './core/service';
import { Store } from './core/store';
import { errorText } from './core/validation';

const root = process.argv[2];
const componentArchive = process.argv[3];
if (!root || !componentArchive || !process.parentPort) throw new Error('Missing desktop host');
mkdirSync(root, { recursive: true, mode: 0o700 });
const service = new AppService(root, new Store(path.join(root, 'messages.sqlite')), event => process.parentPort.postMessage({ event }), componentArchive);
process.parentPort.on('message', async ({ data }: { data: any }) => {
  if (data.type === 'shutdown') { await service.close(); process.exit(0); }
  try {
    const value = data.command?.type === 'resolveAttachment' ? await service.resolveAttachment(data.command) : await service.request(data.command);
    process.parentPort.postMessage({ id: data.id, value });
  } catch (error) { process.parentPort.postMessage({ id: data.id, error: errorText(error) }); }
});
process.parentPort.postMessage({ ready: true });
