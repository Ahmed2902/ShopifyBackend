import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const services = {
  backend: {
    repository: 'Ahmed2902/ShopifyBackend',
    image: 'ghcr.io/ahmed2902/metrico-backend',
    port: 3001,
    path: '/health/ready',
    status: 'ready',
  },
  frontend: {
    repository: 'Ahmed2902/metrico-frontend',
    image: 'ghcr.io/ahmed2902/metrico-frontend',
    port: 3000,
    path: '/api/health',
    status: 'ok',
  },
};

export function deploymentConfig(environment) {
  const service = environment.DEPLOY_SERVICE;
  const specification = services[service];
  if (
    !specification ||
    environment.GITHUB_REPOSITORY !== specification.repository ||
    environment.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error('Deployment requires the matching Metrico repository and main branch.');
  }
  const sha = environment.RELEASE_SHA;
  const image = environment.RELEASE_IMAGE;
  if (
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !new RegExp(`^${specification.image.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`).test(
      image ?? '',
    )
  ) {
    throw new Error('Deployment requires the exact published image digest and full release SHA.');
  }
  const group = environment.AZURE_RESOURCE_GROUP;
  const app = environment.AZURE_CONTAINER_APP;
  if (
    !group ||
    group.length > 90 ||
    [...group].some((character) => character.charCodeAt(0) < 32) ||
    !/^(?!.*--)[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(app ?? '')
  ) {
    throw new Error(
      'Set AZURE_RESOURCE_GROUP and AZURE_CONTAINER_APP to existing Azure resources.',
    );
  }
  const run = environment.GITHUB_RUN_ID;
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  if (!/^\d{1,15}$/.test(run ?? '') || !/^\d{1,4}$/.test(attempt ?? '')) {
    throw new Error('Deployment requires a GitHub Actions run identity.');
  }
  const suffix = `gh-${sha.slice(0, 12)}-${run}-${attempt}`;
  return {
    ...specification,
    service,
    sha,
    image,
    group,
    app,
    suffix,
    revision: `${app}--${suffix}`,
  };
}

export function validateApp(app, config) {
  if (app?.mode !== 'Single' || app?.external !== true || app?.port !== config.port) {
    throw new Error('Use Single revision mode and public HTTP ingress on the service port.');
  }
  if (!/^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(app.fqdn ?? '')) {
    throw new Error('The existing Container App must have its Azure HTTPS hostname.');
  }
  if (app.containers?.length !== 1)
    throw new Error('This deployment supports one container per app.');
  const container = app.containers[0];
  if (container.command?.length || container.args?.length) {
    throw new Error('Clear Azure command and arguments overrides before enabling deployment.');
  }
  if (
    !app.registries?.some((registry) => registry.server === 'ghcr.io' && registry.passwordSecretRef)
  ) {
    throw new Error('Configure the existing private GHCR registry credentials in Azure first.');
  }
  if (
    !container.probes?.some(
      (probe) =>
        probe.type === 'Readiness' &&
        probe.httpGet?.port === config.port &&
        probe.httpGet?.path === config.path,
    )
  ) {
    throw new Error(
      `Configure an HTTP readiness probe on ${config.path} before enabling deployment.`,
    );
  }
  if (config.service === 'backend') {
    if (app.scale?.minReplicas !== 1 || app.scale?.maxReplicas !== 1) {
      throw new Error('The combined backend must use minimum and maximum replicas of one.');
    }
    const startup = container.probes.find((probe) => probe.type === 'Startup');
    if (
      startup?.httpGet?.path !== '/health/live' ||
      startup.httpGet.port !== 3001 ||
      (startup.failureThreshold ?? 3) * (startup.periodSeconds ?? 10) < 600
    ) {
      throw new Error(
        'Configure the backend HTTP startup probe to allow ten minutes for migrations.',
      );
    }
  }
  return container.name;
}

// The query deliberately excludes environment values and secret bodies.
const appQuery =
  '{mode:properties.configuration.activeRevisionsMode,external:properties.configuration.ingress.external,port:properties.configuration.ingress.targetPort,fqdn:properties.configuration.ingress.fqdn,registries:properties.configuration.registries[].{server:server,passwordSecretRef:passwordSecretRef},scale:properties.template.scale,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName,containers:properties.template.containers[].{name:name,image:image,command:command,args:args,probes:probes}}';

export async function deployAzure(
  config,
  {
    azure,
    latestMain,
    healthyHttp,
    sleep = () => setTimeout(10_000),
    attempts = 72,
    log = console.log,
  },
) {
  if ((await latestMain()) !== config.sha) {
    log('Skipping outdated release; main has advanced.');
    return { skipped: true };
  }
  const base = ['--name', config.app, '--resource-group', config.group];
  const show = () => azure(['containerapp', 'show', ...base, '--query', appQuery]);
  const existing = await show();
  const container = validateApp(existing, config);
  // Recheck after Azure reads, immediately before the only resource mutation.
  if ((await latestMain()) !== config.sha) {
    log('Skipping outdated release; main advanced during preflight.');
    return { skipped: true };
  }
  log(
    `Deploying ${config.service} release ${config.sha}; previous ready revision: ${existing.ready ?? 'none'}.`,
  );
  await azure(
    [
      'containerapp',
      'update',
      ...base,
      '--container-name',
      container,
      '--image',
      config.image,
      '--revision-suffix',
      config.suffix,
      '--set-env-vars',
      `SENTRY_RELEASE=${config.service}-${config.sha}`,
      '--no-wait',
    ],
    true,
  );
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = await show();
    const revision = await azure([
      'containerapp',
      'revision',
      'list',
      ...base,
      '--query',
      `[?name=='${config.revision}'] | [0].{health:properties.healthState,provisioning:properties.provisioningState,running:properties.runningState,active:properties.active,containers:properties.template.containers[].{name:name,image:image}}`,
    ]);
    if (
      revision &&
      (revision.provisioning === 'Failed' ||
        revision.running === 'Failed' ||
        revision.provisioning === 'Deprovisioned')
    ) {
      throw new Error(
        `New revision ${config.revision} failed. Inspect its Azure system/container logs; no database rollback was attempted.`,
      );
    }
    if (
      state.latest === config.revision &&
      state.ready === config.revision &&
      revision?.active &&
      revision.health === 'Healthy' &&
      revision.provisioning === 'Provisioned' &&
      revision.containers?.some((item) => item.name === container && item.image === config.image)
    ) {
      if (await healthyHttp(`https://${state.fqdn}${config.path}`, config.status)) {
        log(`Deployment succeeded: ${config.revision} is healthy and serving the published image.`);
        return {
          skipped: false,
          revision: config.revision,
          image: config.image,
          previousRevision: existing.ready,
        };
      }
    }
    if (attempt % 6 === 0)
      log(
        `Waiting for the new revision (${revision?.provisioning ?? 'not created'}, ${revision?.health ?? 'not healthy'}).`,
      );
    if (attempt < attempts - 1) await sleep();
  }
  throw new Error(
    `New revision ${config.revision} did not become ready within the deployment window. An old healthy revision does not count as success.`,
  );
}

export function azureCommand(args, mutation = false, execute = execFileSync) {
  try {
    const output = execute(
      'az',
      [...args, '--only-show-errors', '--output', mutation ? 'none' : 'json'],
      { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return mutation || !output.trim() ? null : JSON.parse(output);
  } catch {
    throw new Error(
      `Azure ${args.slice(0, 2).join(' ')} failed. Check the resource names, role assignment and Azure deployment status.`,
    );
  }
}

async function main() {
  const config = deploymentConfig(process.env);
  const azure = async (args, mutation = false) => azureCommand(args, mutation);
  const latestMain = async () => {
    if (!process.env.GH_TOKEN) throw new Error('GitHub deployment token is missing.');
    const response = await fetch(
      `https://api.github.com/repos/${config.repository}/git/ref/heads/main`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error('Cannot verify the current main release; deployment stopped.');
    const value = await response.json();
    if (!/^[a-f0-9]{40}$/.test(value.object?.sha ?? ''))
      throw new Error('Invalid main release response.');
    return value.object.sha;
  };
  const healthyHttp = async (url, status) => {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      return response.status === 200 && (await response.json()).status === status;
    } catch {
      return false;
    }
  };
  const result = await deployAzure(config, { azure, latestMain, healthyHttp });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      result.skipped
        ? '\nAzure deployment skipped because main advanced.\n'
        : `\nDeployed ${config.service}: ${result.revision}\n\nImage: ${result.image}\n\nPrevious ready revision: ${result.previousRevision ?? 'none'}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
