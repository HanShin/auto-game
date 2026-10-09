import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { developerEnvironment, root } from './environment.mjs';

// Project dependencies let Appium discover the matching XCUITest driver.
const env = developerEnvironment();
delete env.APPIUM_HOME;
const child = spawn(process.execPath, [
  resolve(root, 'node_modules/appium/build/lib/main.js'),
  '--address', '127.0.0.1', '--port', '4723', '--use-drivers', 'xcuitest',
  ...process.argv.slice(2),
], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
