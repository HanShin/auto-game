import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtime = resolve(root, '.runtime');

export function developerEnvironment() {
  const env = { ...process.env };
  const xcode = '/Applications/Xcode.app/Contents/Developer';
  if (!env.DEVELOPER_DIR && existsSync(xcode)) env.DEVELOPER_DIR = xcode;
  return env;
}
