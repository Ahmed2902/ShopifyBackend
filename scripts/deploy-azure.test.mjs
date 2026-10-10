import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployAzure, deploymentConfig } from './deploy-azure.mjs';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
function environment(service = 'backend') {
  return {
    DEPLOY_SERVICE: service,
    GITHUB_REPOSITORY:
      service === 'backend' ? 'Ahmed2902/ShopifyBackend' : 'Ahmed2902/metrico-frontend',
    GITHUB_REF: 'refs/heads/main',
    RELEASE_SHA: sha,
    RELEASE_IMAGE: `ghcr.io/ahmed2902/metrico-${service}@sha256:${digest}`,
    AZURE_RESOURCE_GROUP: 'metrico-production',
    AZURE_CONTAINER_APP: `metrico-${service}`,
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '1',
  };
}
function app(config) {
  return {
    mode: 'Single',
    external: true,
    port: config.port,
    fqdn: 'metrico.fixture.northeurope.azurecontainerapps.io',
    registries: [{ server: 'ghcr.io', passwordSecretRef: 'registry-token' }],
    scale: { minReplicas: 1, maxReplicas: 1 },
    latest: 'old',
    ready: 'old',
    containers: [
      {
        name: config.service,
        command: [],
        args: [],
        probes: [
          { type: 'Readiness', httpGet: { path: config.path, port: config.port } },
          {
            type: 'Startup',
            httpGet: { path: '/health/live', port: 3001 },
            failureThreshold: 60,
            periodSeconds: 10,
          },
        ],
      },
    ],
  };
}
function harness(config = deploymentConfig(environment()), options = {}) {
  const initial = app(config);
  options.configure?.(initial);
  const mutations = [];
  const httpCalls = [];
  let updated = false;
  let reads = 0;
  let mainReads = 0;
  const dependencies = {
    azure: async (args, mutation = false) => {
      if (mutation) {
        mutations.push(args);
        updated = true;
        return null;
      }
      if (args[1] === 'show') {
        if (!updated) return initial;
        reads++;
        if (options.oldReady) return initial;
        return { ...initial, latest: config.revision, ready: config.revision };
      }
      assert.equal(args[1], 'revision');
      if (options.noRevision || (options.delay && reads === 1)) return null;
      return {
        active: true,
        health: 'Healthy',
        provisioning: 'Provisioned',
        running: 'Running',
        containers: [{ name: config.service, image: config.image }],
        ...options.revision,
      };
    },
    latestMain: async () => {
      mainReads++;
      return options.main?.(mainReads) ?? sha;
    },
    healthyHttp: async (url, status) => {
      httpCalls.push([url, status]);
      return options.http ?? true;
    },
    sleep: async () => {},
    attempts: 2,
    log: () => {},
  };
  return { config, dependencies, mutations, httpCalls };
}

for (const service of ['backend', 'frontend']) {
  test(`deploys the published ${service} digest and checks the new revision`, async () => {
    const h = harness(deploymentConfig(environment(service)), { delay: true });
    const result = await deployAzure(h.config, h.dependencies);
    assert.equal(result.revision, h.config.revision);
    assert.equal(result.previousRevision, 'old');
    assert.equal(h.mutations.length, 1);
    const args = h.mutations[0];
    assert.equal(args[args.indexOf('--image') + 1], h.config.image);
    assert.equal(args[args.indexOf('--container-name') + 1], service);
    assert.ok(args.includes(`SENTRY_RELEASE=${service}-${sha}`));
    assert.ok(
      !args.some((value) => /replace-env|remove-env|secret|registry-password|command/.test(value)),
    );
    assert.deepEqual(h.httpCalls, [
      [`https://${app(h.config).fqdn}${h.config.path}`, h.config.status],
    ]);
  });
}
for (const main of [() => 'c'.repeat(40), (count) => (count === 1 ? sha : 'c'.repeat(40))]) {
  test('does not mutate Azure when main advances before deployment', async () => {
    const h = harness(undefined, { main });
    assert.equal((await deployAzure(h.config, h.dependencies)).skipped, true);
    assert.equal(h.mutations.length, 0);
  });
}
test('cannot verify main: deployment stops without changing Azure', async () => {
  const h = harness();
  h.dependencies.latestMain = async () => {
    throw new Error('GitHub unavailable');
  };
  await assert.rejects(deployAzure(h.config, h.dependencies), /GitHub unavailable/);
  assert.equal(h.mutations.length, 0);
});
for (const [label, configure] of [
  [
    'multiple revisions',
    (value) => {
      value.mode = 'Multiple';
    },
  ],
  [
    'command override',
    (value) => {
      value.containers[0].command = ['node', 'dist/server.js'];
    },
  ],
  [
    'missing readiness',
    (value) => {
      value.containers[0].probes = [];
    },
  ],
  [
    'short startup window',
    (value) => {
      value.containers[0].probes[1].failureThreshold = 3;
    },
  ],
  [
    'multiple backend replicas',
    (value) => {
      value.scale.maxReplicas = 2;
    },
  ],
  [
    'missing private registry',
    (value) => {
      value.registries = [];
    },
  ],
]) {
  test(`rejects ${label} without changing the deployment`, async () => {
    const h = harness(undefined, { configure });
    await assert.rejects(deployAzure(h.config, h.dependencies));
    assert.equal(h.mutations.length, 0);
  });
}
for (const options of [
  { oldReady: true },
  { noRevision: true },
  { http: false },
  { revision: { health: 'Unhealthy' } },
  { revision: { containers: [{ name: 'backend', image: 'wrong-image' }] } },
]) {
  test(`does not report rollout success for ${JSON.stringify(options)}`, async () => {
    const h = harness(undefined, options);
    await assert.rejects(deployAzure(h.config, h.dependencies), /did not become ready/);
  });
}
test('a failed migration/revision fails deployment even if the old revision serves HTTP', async () => {
  const h = harness(undefined, { oldReady: true, revision: { provisioning: 'Failed' } });
  await assert.rejects(deployAzure(h.config, h.dependencies), /failed/);
  assert.equal(h.httpCalls.length, 0);
});
for (const overrides of [
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REPOSITORY: 'someone/fork' },
  { RELEASE_SHA: 'main' },
  { RELEASE_IMAGE: 'ghcr.io/ahmed2902/metrico-backend:latest' },
  { RELEASE_IMAGE: `ghcr.io/ahmed2902/metrico-frontend@sha256:${digest}` },
  { AZURE_RESOURCE_GROUP: '' },
  { AZURE_CONTAINER_APP: '' },
  { GITHUB_RUN_ID: 'not-a-run' },
]) {
  test(`rejects an invalid deployment identity/input: ${Object.keys(overrides)}`, () => {
    assert.throws(() => deploymentConfig({ ...environment(), ...overrides }));
  });
}
