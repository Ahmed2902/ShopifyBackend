import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(overrides = {}, freshBackup = true) {
  const dir = mkdtempSync(join(tmpdir(), 'metrico-monitor-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const script of ['monitor.sh', 'check-health.sh', 'backup-monitored.sh']) {
    copyFileSync(new URL(`../deploy/${script}`, import.meta.url), join(dir, script));
  }
  writeFileSync(join(dir, 'backup.sh'), '#!/bin/bash\nexit ${BACKUP_EXIT:-0}\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/bash
case "$*" in
  *scripts/monitor-check-in.mjs*) printf '%s\\n' "\${@: -1}" >> "$MONITOR_LOG" ;;
  *' ps -q '*) echo fake-container ;;
  *'inspect --format {{.State.Status}}'*) echo running ;;
  *'inspect --format'*) echo "\${SERVICE_HEALTH:-healthy}" ;;
  stats*) echo "\${MEM_PERCENT:-5.0}%" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\nexit ${CURL_EXIT:-0}\n', { mode: 0o755 });
  writeFileSync(
    join(bin, 'df'),
    '#!/bin/bash\nprintf "Filesystem Blocks Used Available Capacity Mounted\\n/dev/fake 100 20 80 %s%% /\\n" "${DISK_PERCENT:-20}"\n',
    { mode: 0o755 },
  );
  mkdirSync(join(dir, 'backups'));
  if (freshBackup)
    writeFileSync(join(dir, 'backups/metrico-public-test.dump.age'), 'encrypted fixture');
  const log = join(dir, 'monitor.log');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MONITOR_LOG: log,
    ...overrides,
  };
  return { dir, log, env };
}

for (const [name, env, fresh, expected] of [
  ['healthy deployment', {}, true, 'ok'],
  ['unhealthy worker', { SERVICE_HEALTH: 'unhealthy' }, true, 'error'],
  ['failed HTTPS', { CURL_EXIT: '1' }, true, 'error'],
  ['disk pressure', { DISK_PERCENT: '80' }, true, 'error'],
  ['container memory pressure', { MEM_PERCENT: '91.0' }, true, 'error'],
  ['missing backup', {}, false, 'error'],
]) {
  test(`host monitor reports ${name}`, () => {
    const f = fixture(env, fresh);
    try {
      const result = spawnSync('bash', ['./monitor.sh'], {
        cwd: f.dir,
        env: f.env,
        encoding: 'utf8',
      });
      assert.equal(result.status, expected === 'ok' ? 0 : 1, result.stderr);
      assert.equal(readFileSync(f.log, 'utf8').trim(), expected);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

test('backup failure persists until a successful backup and reuses the host monitor', () => {
  const f = fixture({ BACKUP_EXIT: '1' });
  try {
    const failed = spawnSync('bash', ['./backup-monitored.sh'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(readFileSync(join(f.dir, 'backup.status'), 'utf8').trim(), 'error');
    assert.equal(readFileSync(f.log, 'utf8').trim(), 'error');
    const recovered = spawnSync('bash', ['./backup-monitored.sh'], {
      cwd: f.dir,
      env: { ...f.env, BACKUP_EXIT: '0' },
      encoding: 'utf8',
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(join(f.dir, 'backup.status'), 'utf8').trim(), 'ok');
    assert.equal(readFileSync(f.log, 'utf8').trim(), 'error\nok');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
