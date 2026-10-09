import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('invalid startup configuration aborts before worker stop, backup or migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'metrico-preflight-'));
  try {
    const trace = join(directory, 'commands');
    copyFileSync(new URL('../deploy/release.sh', import.meta.url), join(directory, 'release.sh'));
    writeFileSync(join(directory, 'backend.env'), 'NODE_ENV=production\n');
    writeFileSync(
      join(directory, 'release.env'),
      [
        ['BACKEND_IMAGE', 'ghcr.io/ahmed2902/metrico-backend'],
        ['MIGRATION_IMAGE', 'ghcr.io/ahmed2902/metrico-migrations'],
        ['FRONTEND_IMAGE', 'ghcr.io/ahmed2902/metrico-frontend'],
        ['PROXY_IMAGE', 'caddy'],
      ]
        .map(([name, repository]) => `${name}=${repository}@sha256:${'a'.repeat(64)}`)
        .join('\n'),
    );
    writeFileSync(
      join(directory, 'docker'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RELEASE_TRACE"
if [[ "$*" == *scripts/check-production-env.mjs* ]]; then exit 1; fi
`,
      { mode: 0o700 },
    );
    const result = spawnSync('bash', [join(directory, 'release.sh')], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELEASE_TRACE: trace },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    const commands = readFileSync(trace, 'utf8');
    assert.match(
      commands,
      /run --rm -T --entrypoint node migrate scripts\/check-production-env\.mjs/,
    );
    assert.doesNotMatch(
      commands,
      /stop worker|start worker|run --rm -T backup|run --rm -T migrate|up -d/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ['backup', 'runtime', 'worker-health']) {
  test(`worker recovery after ${failure} failure only resumes an unreplaced worker`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'metrico-worker-recovery-'));
    try {
      const trace = join(directory, 'commands');
      copyFileSync(new URL('../deploy/release.sh', import.meta.url), join(directory, 'release.sh'));
      writeFileSync(join(directory, 'backend.env'), 'NODE_ENV=production\n');
      writeFileSync(join(directory, 'release.env'), [
        ['BACKEND_IMAGE', 'ghcr.io/ahmed2902/metrico-backend'],
        ['MIGRATION_IMAGE', 'ghcr.io/ahmed2902/metrico-migrations'],
        ['FRONTEND_IMAGE', 'ghcr.io/ahmed2902/metrico-frontend'],
        ['PROXY_IMAGE', 'caddy'],
      ].map(([name, repository]) => `${name}=${repository}@sha256:${'a'.repeat(64)}`).join('\n'));
      writeFileSync(join(directory, 'backup.sh'), `#!/usr/bin/env bash
printf 'backup\\n' >> "$RELEASE_TRACE"
if [[ "$RELEASE_FAILURE" == backup ]]; then exit 7; fi
`, { mode: 0o700 });
      writeFileSync(join(directory, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RELEASE_TRACE"
if [[ "$RELEASE_FAILURE" == runtime && "$*" == *"up -d --wait"* ]]; then exit 7; fi
if [[ "$RELEASE_FAILURE" == worker-health && "$*" == *"exec -T worker"* ]]; then exit 7; fi
`, { mode: 0o700 });
      const result = spawnSync('bash', [join(directory, 'release.sh')], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELEASE_TRACE: trace, RELEASE_FAILURE: failure },
        encoding: 'utf8',
      });
      assert.equal(result.status, 7);
      const commands = readFileSync(trace, 'utf8');
      assert.match(commands, /stop worker/);
      if (failure === 'backup') {
        assert.match(commands, /start worker/);
        assert.doesNotMatch(commands, /up -d/);
      } else {
        assert.match(commands, /up -d --wait/);
        assert.doesNotMatch(commands, /start worker/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
