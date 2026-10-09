import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { sanitizeMonitoringEvent } from './monitoring-privacy.js';

const enabled = env.NODE_ENV === 'production' && Boolean(env.SENTRY_DSN);
if (enabled) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: 'production',
    release: env.SENTRY_RELEASE,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    tracePropagationTargets: [],
    maxBreadcrumbs: 0,
    beforeSend: (event) => {
      const safe = sanitizeMonitoringEvent(event);
      if (safe) safe.tags = { service: env.SENTRY_SERVICE };
      return safe;
    },
  });
}

// Bound both memory and repeat reports from one-second polling loops.
const recentErrors = new Map<string, number>();
export function reportException(error: unknown): void {
  if (!enabled || !(error instanceof Error)) return;
  try {
    const now = Date.now();
    const key = error.stack?.split('\n').slice(1, 5).join('\n') || error.name;
    for (const [signature, until] of recentErrors) {
      if (until <= now) recentErrors.delete(signature);
    }
    if (recentErrors.has(key) || recentErrors.size >= 100) return;
    recentErrors.set(key, now + 300_000);
    Sentry.captureException(error);
  } catch {
    // Observability must not interrupt application or queue work.
  }
}

export function reportWorkerHeartbeat(healthy: boolean): void {
  if (!enabled || !env.SENTRY_WORKER_MONITOR_SLUG) return;
  try {
    Sentry.captureCheckIn(
      {
        monitorSlug: env.SENTRY_WORKER_MONITOR_SLUG,
        status: healthy ? 'ok' : 'error',
      },
      {
        schedule: { type: 'interval', value: 5, unit: 'minute' },
        checkinMargin: 2,
        timezone: 'UTC',
        failureIssueThreshold: 1,
        recoveryThreshold: 1,
      },
    );
  } catch {
    // A Sentry outage must not stop the worker.
  }
}

export async function flushMonitoring(): Promise<boolean> {
  if (!enabled) return true;
  try {
    return await Sentry.flush(2_000);
  } catch {
    return false;
  }
}
