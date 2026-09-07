import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import { requestPerformanceMiddleware } from '../../src/middleware/request-performance.middleware.js';

function responseFixture() {
  const events = new EventEmitter();
  return Object.assign(events, {
    statusCode: 200,
    writableFinished: false,
    getHeader: vi.fn((name: string) => (name.toLowerCase() === 'x-request-id' ? 'request-1' : undefined)),
  }) as unknown as Response & EventEmitter;
}

const request = {
  method: 'GET',
  path: '/v1/stores/store-1/analytics/dashboard',
  originalUrl: '/v1/stores/store-1/analytics/dashboard?days=30',
} as Request;

describe('requestPerformanceMiddleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records an early client disconnect once even if finish is emitted later', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const res = responseFixture();
    const next = vi.fn();

    requestPerformanceMiddleware(request, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.emit('close');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'aborted_request',
        requestId: 'request-1',
        aborted: true,
        prismaQueryCount: 0,
      }),
      'Aborted request',
    );

    // Defensive: if an unusual stream sequence emits finish afterwards, telemetry is still single-shot.
    Object.assign(res, { writableFinished: true });
    res.emit('finish');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
