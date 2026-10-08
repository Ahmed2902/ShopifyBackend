import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireMainCi } from './require-main-ci.mjs';

const sha = 'a'.repeat(40);
const repository = { owner: 'Ahmed2902', repo: 'MetricoFixture' };
const good = {
  id: 10,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  head_repository: { full_name: 'Ahmed2902/MetricoFixture' },
  status: 'completed',
  conclusion: 'success',
};
function input(runs, overrides = {}) {
  return {
    repository,
    sha,
    ref: 'refs/heads/main',
    ...overrides,
    github: {
      rest: {
        actions: {
          listWorkflowRuns: async (query) => {
            assert.deepEqual(query, {
              ...repository,
              workflow_id: 'ci.yml',
              head_sha: sha,
              branch: 'main',
              event: 'push',
              per_page: 100,
            });
            return { data: { workflow_runs: runs } };
          },
        },
      },
    },
  };
}

test('accepts successful main CI for the checked-out release', async () => {
  assert.equal(await requireMainCi(input([good])), 10);
});
test('rejects a missing main-push run', async () => {
  await assert.rejects(requireMainCi(input([])), /has not passed/);
});
for (const patch of [
  { head_sha: 'b'.repeat(40) },
  { head_branch: 'feature' },
  { event: 'pull_request' },
  { head_repository: { full_name: 'SomeoneElse/MetricoFixture' } },
]) {
  test(`rejects unrelated CI: ${JSON.stringify(patch)}`, async () => {
    await assert.rejects(requireMainCi(input([{ ...good, ...patch }])), /has not passed/);
  });
}
for (const [status, conclusion] of [
  ['in_progress', null],
  ['queued', null],
  ['completed', 'failure'],
  ['completed', 'cancelled'],
  ['completed', 'skipped'],
]) {
  test(`a newer ${status}/${conclusion} run blocks an older success`, async () => {
    await assert.rejects(
      requireMainCi(input([good, { ...good, id: 11, status, conclusion }])),
      /has not passed/,
    );
  });
}
test('rejects non-main dispatches before requesting CI', async () => {
  await assert.rejects(requireMainCi(input([good], { ref: 'refs/heads/feature' })), /requires/);
});
test('rejects missing or malformed release SHAs', async () => {
  await assert.rejects(requireMainCi(input([good], { sha: 'main' })), /requires/);
});
