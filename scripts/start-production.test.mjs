import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function fixture(mode, signalAtMigration = false) {
  const directory = mkdtempSync(join(tmpdir(), 'metrico-startup-'));
  let child;
  try {
    for (const path of ['scripts', 'node_modules/prisma/build', 'dist']) {
      mkdirSync(join(directory, path), { recursive: true });
    }
    copyFileSync(
      new URL('./start-production.mjs', import.meta.url),
      join(directory, 'scripts/start-production.mjs'),
    );
    const phase = (name) => `
      const fs = require('node:fs');
      fs.appendFileSync('phases.txt', '${name}\\n');
      if (process.env.MODE === '${name}-fail') process.exit(7);
      if (process.env.MODE === '${name}-wait') {
        process.on('SIGTERM', () => { fs.appendFileSync('phases.txt', 'terminated\\n'); process.exit(0); });
        setInterval(() => {}, 1000);
        console.log('migration-waiting');
      }
    `;
    writeFileSync(
      join(directory, 'scripts/check-production-env.mjs'),
      phase('config').replace("const fs = require('node:fs');", "import fs from 'node:fs';"),
    );
    writeFileSync(join(directory, 'node_modules/prisma/build/index.js'), phase('migration'));
    writeFileSync(join(directory, 'dist/server.js'), phase('runtime'));
    child = spawn(process.execPath, [join(directory, 'scripts/start-production.mjs')], {
      env: { ...process.env, MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const completion = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (signalAtMigration && output.includes('migration-waiting')) {
        signalAtMigration = false;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const [status] = await completion;
    return {
      status,
      output,
      phases: readFileSync(join(directory, 'phases.txt'), 'utf8').trim().split('\n'),
    };
  } finally {
    child?.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  'configuration and migrations succeed before the combined runtime starts',
  { timeout: 5000 },
  async () => {
    const result = await fixture('success');
    assert.equal(result.status, 0);
    assert.deepEqual(result.phases, ['config', 'migration', 'runtime']);
  },
);
test(
  'invalid configuration never runs migrations or accepts traffic',
  { timeout: 5000 },
  async () => {
    const result = await fixture('config-fail');
    assert.equal(result.status, 7);
    assert.deepEqual(result.phases, ['config']);
  },
);
test(
  'migration failure stops startup and preserves the failure code',
  { timeout: 5000 },
  async () => {
    const result = await fixture('migration-fail');
    assert.equal(result.status, 7);
    assert.deepEqual(result.phases, ['config', 'migration']);
  },
);
test(
  'container termination reaches the migration process and prevents runtime startup',
  { timeout: 5000 },
  async () => {
    const result = await fixture('migration-wait', true);
    assert.equal(result.status, 143);
    assert.deepEqual(result.phases, ['config', 'migration', 'terminated']);
  },
);
test(
  'combined runtime failures are returned to the container platform',
  { timeout: 5000 },
  async () => {
    assert.equal((await fixture('runtime-fail')).status, 7);
  },
);
