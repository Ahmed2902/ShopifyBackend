// Publication must verify the checked-out commit, including manual retries.
export async function requireMainCi({ github, repository, sha, ref }) {
  if (ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw new Error('Container publication requires a checked-out main commit.');
  }
  const fullName = `${repository.owner}/${repository.repo}`;
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repository,
    workflow_id: 'ci.yml',
    head_sha: sha,
    branch: 'main',
    event: 'push',
    per_page: 100,
  });
  // Do not filter the API to success: a newer failed or pending run must block publication.
  const latest = data.workflow_runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === 'main' &&
        run.event === 'push' &&
        run.head_repository?.full_name === fullName,
    )
    .sort((left, right) => right.id - left.id)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
    throw new Error(
      `Main-push CI has not passed for release ${sha}. Wait for CI or fix and rerun it before publishing.`,
    );
  }
  return latest.id;
}
