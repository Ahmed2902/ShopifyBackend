import { readFile } from 'node:fs/promises';
try {
  const status = JSON.parse(
    await readFile(process.env.WORKER_HEALTH_FILE ?? '/tmp/metrico-worker-health.json', 'utf8'),
  );
  if (
    !status.healthy ||
    !Number.isFinite(status.updatedAt) ||
    Date.now() - status.updatedAt > 90_000 ||
    status.updatedAt > Date.now() + 5_000
  )
    process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
