import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

export function resolveProfileDirectory(appData: string): string {
  const current = path.join(appData, 'ChanceKit');
  const legacy = path.join(appData, '群讯');
  // Move the complete profile, including SQLite WAL files and QQ login data.
  if (!existsSync(current) && existsSync(legacy)) renameSync(legacy, current);
  return current;
}
