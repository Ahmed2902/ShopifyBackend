import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run each phase without a shell or runtime downloads. Never accept traffic or
// start queue processing when configuration validation or migrations fail.
const directory = fileURLToPath(new URL('../', import.meta.url));
let child;
let stopping = false;
let stopTimer;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    child?.kill(signal);
    stopTimer = setTimeout(() => child?.kill('SIGKILL'), 15_000);
    stopTimer.unref();
  });
}

async function run(label, args) {
  if (stopping) return false;
  console.log(`[startup] ${label}`);
  const code = await new Promise((resolve) => {
    child = spawn(process.execPath, args, { cwd: directory, stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', (status) => resolve(status ?? 1));
  });
  child = undefined;
  if (stopTimer) clearTimeout(stopTimer);
  if (stopping) return false;
  if (code !== 0) {
    console.error(`[startup] ${label} failed; container is stopping.`);
    process.exitCode = code;
    return false;
  }
  return true;
}

if (
  (await run('Validate production configuration', ['scripts/check-production-env.mjs'])) &&
  (await run('Apply pending database migrations', [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
  ]))
) {
  await run('Start API and workers', ['dist/server.js']);
}
