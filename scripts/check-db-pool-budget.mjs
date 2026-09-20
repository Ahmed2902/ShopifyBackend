function integerValue(name, raw, fallback, min = 0) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min) {
    const requirement = min === 0 ? 'a non-negative integer' : `an integer >= ${min}`;
    throw new Error(`${name} must be ${requirement}`);
  }
  return value;
}

// src/lib/postgres-advisory-lock.ts owns a separate pg.Pool with max=4. It is exercised by the
// worker-side Pixel behavior/attribution rollups, so each worker process must reserve this pool in
// addition to the Prisma/node-postgres pool. Keep this constant aligned with that runtime pool.
const BUILT_IN_ADVISORY_LOCK_POOL_MAX = 4;

export function calculateDbPoolBudget(input = process.env) {
  const poolMax = integerValue('DATABASE_POOL_MAX', input.DATABASE_POOL_MAX, 10, 1);
  const apiInstances = integerValue('API_INSTANCES', input.API_INSTANCES, 1);
  const workerInstances = integerValue('WORKER_INSTANCES', input.WORKER_INSTANCES, 1);
  const otherPools = integerValue(
    'OTHER_DATABASE_POOL_CONNECTIONS',
    input.OTHER_DATABASE_POOL_CONNECTIONS,
    0,
  );
  const connectionLimit = integerValue(
    'DATABASE_CONNECTION_LIMIT',
    input.DATABASE_CONNECTION_LIMIT,
    0,
  );
  const reserve = integerValue(
    'DATABASE_CONNECTION_RESERVE',
    input.DATABASE_CONNECTION_RESERVE,
    10,
  );

  const processCount = apiInstances + workerInstances;
  if (processCount === 0) {
    throw new Error('At least one API_INSTANCES or WORKER_INSTANCES process is required');
  }

  const prismaPoolConnections = processCount * poolMax;
  const advisoryLockPoolConnections = workerInstances * BUILT_IN_ADVISORY_LOCK_POOL_MAX;
  const plannedApplicationConnections =
    prismaPoolConnections + advisoryLockPoolConnections + otherPools;
  const usableConnections = connectionLimit > 0 ? Math.max(0, connectionLimit - reserve) : null;
  const safe = usableConnections === null || plannedApplicationConnections <= usableConnections;

  return {
    poolMax,
    apiInstances,
    workerInstances,
    otherPools,
    processCount,
    prismaPoolConnections,
    advisoryLockPoolConnections,
    plannedApplicationConnections,
    connectionLimit: connectionLimit || null,
    reserve: connectionLimit > 0 ? reserve : null,
    usableConnections,
    safe,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`DB pool budget self-test failed: ${message}`);
}

function runSelfTest() {
  const safe = calculateDbPoolBudget({
    DATABASE_POOL_MAX: '5',
    API_INSTANCES: '2',
    WORKER_INSTANCES: '1',
    OTHER_DATABASE_POOL_CONNECTIONS: '2',
    DATABASE_CONNECTION_LIMIT: '40',
    DATABASE_CONNECTION_RESERVE: '10',
  });
  assert(safe.prismaPoolConnections === 15, 'Prisma pool arithmetic');
  assert(safe.advisoryLockPoolConnections === 4, 'built-in advisory pool arithmetic');
  assert(safe.plannedApplicationConnections === 21, 'planned connection arithmetic');
  assert(safe.usableConnections === 30 && safe.safe, 'safe plan classification');

  const unsafe = calculateDbPoolBudget({
    DATABASE_POOL_MAX: '10',
    API_INSTANCES: '2',
    WORKER_INSTANCES: '1',
    DATABASE_CONNECTION_LIMIT: '35',
    DATABASE_CONNECTION_RESERVE: '5',
  });
  assert(!unsafe.safe, 'unsafe plan classification includes advisory pool');

  const scientific = calculateDbPoolBudget({
    DATABASE_POOL_MAX: '1e2',
    API_INSTANCES: '1',
    WORKER_INSTANCES: '0',
  });
  assert(scientific.poolMax === 100, 'numeric parsing must match runtime coercion');

  let rejected = false;
  try {
    calculateDbPoolBudget({ DATABASE_POOL_MAX: '10garbage' });
  } catch {
    rejected = true;
  }
  assert(rejected, 'invalid numeric input must be rejected instead of partially parsed');
  console.log('DB pool budget self-test passed.');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const report = calculateDbPoolBudget();
  console.table(report);

  if (report.connectionLimit === null) {
    console.log(
      'DATABASE_CONNECTION_LIMIT is unset; showing planned usage only. Set it in deployment validation to enforce the budget.',
    );
  } else if (!report.safe) {
    console.error(
      `Unsafe DB pool plan: ${report.plannedApplicationConnections} planned connections exceed ${report.usableConnections} usable connections (${report.connectionLimit} limit - ${report.reserve} reserve).`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `DB pool plan is within budget: ${report.plannedApplicationConnections}/${report.usableConnections} usable connections.`,
    );
  }
}
