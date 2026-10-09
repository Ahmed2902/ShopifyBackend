import { reportException, flushMonitoring } from '../dist/lib/monitoring.js';
if (!process.env.SENTRY_DSN || process.env.NODE_ENV !== 'production') {
  console.error('Configure production SENTRY_DSN before running this check.');
  process.exit(1);
}
reportException(new Error('Metrico monitoring installation check'));
if (!(await flushMonitoring())) process.exit(1);
console.log('Sentry queue flushed. Confirm the new issue and alert in your Sentry account.');
