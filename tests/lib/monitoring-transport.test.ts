import { it, expect } from 'vitest';
import * as Sentry from '@sentry/node';
import { sanitizeMonitoringEvent } from '../../src/lib/monitoring-privacy.js';

it('the real SDK transport receives sanitized error envelopes', async () => {
  const envelopes: unknown[] = [];
  Sentry.init({
    dsn: 'https://public@example.test/1',
    defaultIntegrations: false,
    enableRuntimeChannelInjection: false,
    enableOpenTelemetrySetup: false,
    beforeSend: sanitizeMonitoringEvent,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  Sentry.captureException(new TypeError('PRIVATE_PROVIDER_TOKEN'), {
    user: { email: 'customer@example.test' },
    extra: { payload: 'PRIVATE_ORDER_PAYLOAD' },
  });
  expect(await Sentry.flush(1000)).toBe(true);
  const output = JSON.stringify(envelopes);
  expect(envelopes).toHaveLength(1);
  expect(output).not.toContain('PRIVATE_PROVIDER_TOKEN');
  expect(output).not.toContain('PRIVATE_ORDER_PAYLOAD');
  expect(output).not.toContain('customer@example.test');
  expect(output).toContain('TypeError');
  await Sentry.close(1000);
});
