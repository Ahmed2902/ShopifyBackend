import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function run({
  frontend = `ghcr.io/ahmed2902/metrico-frontend@sha256:${'a'.repeat(64)}`,
  proxy = `caddy@sha256:${'b'.repeat(64)}`,
  existing = '',
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'metrico-public-'));
  try {
    const trace = join(directory, 'commands');
    copyFileSync(new URL('../deploy/public.sh', import.meta.url), join(directory, 'public.sh'));
    writeFileSync(
      join(directory, 'release.env'),
      `FRONTEND_IMAGE=${frontend}\nPROXY_IMAGE=${proxy}\n`,
    );
    writeFileSync(
      join(directory, 'docker'),
      `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$PUBLIC_TRACE"
if [[ "$*" == *com.docker.compose.service=api* && "$EXISTING_SERVICE" == api ]]; then echo fixture-api; fi
if [[ "$*" == *com.docker.compose.service=worker* && "$EXISTING_SERVICE" == worker ]]; then echo fixture-worker; fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, 'curl'),
      `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$PUBLIC_TRACE"
`,
      { mode: 0o700 },
    );
    const result = spawnSync('bash', [join(directory, 'public.sh')], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        PUBLIC_TRACE: trace,
        EXISTING_SERVICE: existing,
      },
      encoding: 'utf8',
    });
    return { ...result, commands: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('public bootstrap uses only frontend/proxy and checks the policy URLs', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(
    result.commands,
    /compose.public.yaml up -d --wait --wait-timeout 300 frontend proxy/,
  );
  assert.doesNotMatch(result.commands, /compose.prod.yaml|migrate|stop worker|backend.env/);
  for (const path of ['/api/health', '/privacy', '/terms', '/data-deletion']) {
    assert.ok(result.commands.includes(`https://metrico.live${path}`));
  }
});
for (const existing of ['api', 'worker']) {
  test(`bootstrap refuses to replace a full deployment with an existing ${existing}`, () => {
    const result = run({ existing });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.commands, /docker compose|curl/);
  });
}
for (const values of [
  { frontend: `ghcr.io/ahmed2902/metrico-backend@sha256:${'a'.repeat(64)}` },
  { frontend: 'ghcr.io/ahmed2902/metrico-frontend:latest' },
  { proxy: `caddy@sha256:${'0'.repeat(64)}` },
]) {
  test(`bootstrap rejects unpinned or wrong images: ${JSON.stringify(values)}`, () => {
    const result = run(values);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.commands, /docker compose|curl/);
  });
}
