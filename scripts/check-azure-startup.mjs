import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fixture } from './fixtures/production-env.mjs';

// CI-only fixture credentials and a disposable PostgreSQL database. Exercise
// the published target's default command, not a substitute shell command.
const name = `metrico-startup-${process.pid}`;
const database = 'postgresql://postgres:postgres@localhost:5432/shopify_intelligence_startup_test';
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function start(migrationUrl = database) {
  const environment = {
    ...fixture,
    DATABASE_URL: database,
    MIGRATION_DATABASE_URL: migrationUrl,
    PORT: '3301',
    LOG_LEVEL: 'silent',
    PRISMA_ENGINES_MIRROR: 'http://127.0.0.1:1',
  };
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'host',
    ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    'metrico-backend-azure:ci',
  ]);
}
function remove() {
  docker(['rm', '-f', name], true);
}
async function ready() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (docker(['inspect', '-f', '{{.State.Running}}', name]) !== 'true') {
      throw new Error(`Container stopped: ${docker(['logs', name])}`);
    }
    try {
      const response = await fetch('http://127.0.0.1:3301/health/ready', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      /* Not listening until migrations finish. */
    }
    await setTimeout(1000);
  }
  throw new Error(`Container never became ready: ${docker(['logs', name])}`);
}
try {
  start();
  await ready();
  assert.match(docker(['logs', name]), /Start API and workers/);
  assert.equal((await fetch('http://127.0.0.1:3301/health/live')).status, 200);
  docker(['stop', '--time', '20', name]);
  assert.equal(docker(['inspect', '-f', '{{.State.ExitCode}}', name]), '143');
  remove();
  start();
  await ready();
  assert.match(docker(['logs', name]), /No pending migrations to apply/);
  remove();
  start('postgresql://postgres:postgres@127.0.0.1:1/unavailable?connect_timeout=2');
  for (let attempt = 0; attempt < 30; attempt++) {
    if (docker(['inspect', '-f', '{{.State.Running}}', name]) !== 'true') break;
    await setTimeout(1000);
  }
  assert.equal(docker(['inspect', '-f', '{{.State.Running}}', name]), 'false');
  assert.notEqual(docker(['inspect', '-f', '{{.State.ExitCode}}', name]), '0');
  assert.doesNotMatch(docker(['logs', name]), /Start API and workers/);
  console.log(
    'Azure container passed fresh migration, restart, shutdown and migration failure checks.',
  );
} finally {
  remove();
}
