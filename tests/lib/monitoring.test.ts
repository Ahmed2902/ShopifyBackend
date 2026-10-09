import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '@sentry/node';
import { sanitizeMonitoringEvent } from '../../src/lib/monitoring-privacy.js';

const mocked = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    SENTRY_DSN: 'https://public@example.test/1',
    SENTRY_SERVICE: 'worker',
    SENTRY_RELEASE: 'backend-123',
    SENTRY_WORKER_MONITOR_SLUG: 'metrico-worker',
  },
  init: vi.fn(),
  captureException: vi.fn(),
  captureCheckIn: vi.fn(),
  flush: vi.fn(),
}));
vi.mock('../../src/config/env.js', () => ({ env: mocked.env }));
vi.mock('@sentry/node', () => ({
  ...mocked,
  onUncaughtExceptionIntegration: () => ({ name: 'fatal' }),
  onUnhandledRejectionIntegration: () => ({ name: 'rejection' }),
}));
import {
  reportException,
  reportWorkerHeartbeat,
  flushMonitoring,
} from '../../src/lib/monitoring.js';

const initializedOptions = mocked.init.mock.calls[0]?.[0];

describe('monitoring privacy boundary', () => {
  it('removes customer data, tokens, bodies, SQL, paths, local variables and raw messages', () => {
    const event: Event = {
      event_id: 'abc',
      release: 'backend-123',
      request: {
        url: 'https://example.test?token=SECRET',
        headers: { cookie: 'SECRET' },
        data: 'SECRET',
      },
      user: { email: 'buyer@example.test' },
      extra: { sql: 'SECRET' },
      breadcrumbs: [{ message: 'SECRET' }],
      tags: { store: 'SECRET' },
      message: 'SECRET',
      contexts: { customer: { secret: 'SECRET' } },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'SECRET',
            stacktrace: {
              frames: [
                {
                  filename: 'https://example.test/customer/app.js?token=SECRET',
                  function: 'processOrder',
                  lineno: 7,
                  colno: 2,
                  vars: { secret: 'SECRET' },
                  pre_context: ['SECRET'],
                },
              ],
            },
          },
        ],
      },
    };
    const safe = sanitizeMonitoringEvent(event);
    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(JSON.stringify(safe)).not.toContain('buyer@example.test');
    expect(safe?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: 'app.js',
      function: 'processOrder',
      lineno: 7,
      colno: 2,
      in_app: undefined,
    });
    expect(safe?.request).toBeUndefined();
  });
  it('rejects non-error telemetry and sanitizes custom error names', () => {
    expect(sanitizeMonitoringEvent({ type: 'transaction' })).toBeNull();
    expect(sanitizeMonitoringEvent({ message: 'SECRET' })).toBeNull();
    const safe = sanitizeMonitoringEvent({
      exception: { values: [{ type: 'customer@example.test' }] },
    });
    expect(safe?.exception?.values?.[0]?.type).toBe('Error');
  });
});

describe('Sentry operational wiring', () => {
  beforeEach(() => {
    mocked.captureException.mockReset();
    mocked.captureCheckIn.mockReset();
  });
  it('initializes only error integrations and sanitizes before sending', () => {
    const options = initializedOptions;
    expect(options.defaultIntegrations).toBe(false);
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.beforeSendLog({})).toBeNull();
    expect(options.dataCollection.httpBodies).toEqual([]);
    expect(options.beforeSend({ exception: { values: [{ value: 'SECRET' }] } }).tags).toEqual({
      service: 'worker',
    });
  });
  it('bounds repeated polling errors and never throws when Sentry fails', () => {
    const error = new Error('SECRET');
    error.stack = 'Error: SECRET\n at repeatWorker (jobs.js:12:3)';
    reportException(error);
    reportException(error);
    expect(mocked.captureException).toHaveBeenCalledTimes(1);
    mocked.captureException.mockImplementationOnce(() => {
      throw new Error('network unavailable');
    });
    const other = new Error('other');
    other.stack = 'Error\n at anotherWorker (jobs.js:99:3)';
    expect(() => reportException(other)).not.toThrow();
    expect(() => reportException('SECRET')).not.toThrow();
  });
  it('sends healthy and unhealthy check-ins without customer data', () => {
    reportWorkerHeartbeat(true);
    reportWorkerHeartbeat(false);
    expect(mocked.captureCheckIn.mock.calls.map((call) => call[0])).toEqual([
      { monitorSlug: 'metrico-worker', status: 'ok' },
      { monitorSlug: 'metrico-worker', status: 'error' },
    ]);
    expect(mocked.captureCheckIn.mock.calls[0]?.[1].schedule).toEqual({
      type: 'interval',
      value: 5,
      unit: 'minute',
    });
  });
  it('limits shutdown waiting and handles transport failures', async () => {
    mocked.flush.mockResolvedValueOnce(true);
    expect(await flushMonitoring()).toBe(true);
    expect(mocked.flush).toHaveBeenCalledWith(2_000);
    mocked.flush.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await flushMonitoring()).toBe(false);
  });
});
