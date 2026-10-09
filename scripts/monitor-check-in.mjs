import * as Sentry from '@sentry/node';
const [monitorSlug, status] = process.argv.slice(2);
if (
  !/^[a-z0-9_-]{1,128}$/.test(monitorSlug ?? '') ||
  !['ok', 'error'].includes(status) ||
  !process.env.SENTRY_DSN
) {
  console.error('Pass a valid monitor slug and ok/error status; configure SENTRY_DSN.');
  process.exit(1);
}
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: 'production',
  defaultIntegrations: false,
  enableOpenTelemetrySetup: false,
  enableRuntimeChannelInjection: false,
  beforeSend: () => null,
  beforeSendLog: () => null,
  beforeSendMetric: () => null,
});
Sentry.captureCheckIn(
  { monitorSlug, status },
  {
    schedule: { type: 'interval', value: 5, unit: 'minute' },
    checkinMargin: 2,
    timezone: 'UTC',
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
  },
);
if (!(await Sentry.flush(5_000))) process.exit(1);
