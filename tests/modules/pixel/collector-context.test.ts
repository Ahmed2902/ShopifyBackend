import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { collectorContext } from '../../../src/modules/pixel/collector-context.js';

describe('collector network evidence', () => {
  it('uses the Express-resolved trusted chain, never the first forwarded header value', () => {
    expect(collectorContext({ ip: '8.8.4.4', ips: ['8.8.4.4'], headers: { 'x-forwarded-for': '1.1.1.1, 8.8.4.4' } } as unknown as Request)).toEqual({ clientIp: '8.8.4.4' });
  });
  it('does not record an untrusted proxy as the shopper', () => {
    expect(collectorContext({ ip: '8.8.4.4', ips: [], headers: { 'x-forwarded-for': '1.1.1.1' } } as unknown as Request)).toEqual({});
  });
  it.each(['127.0.0.1', '10.0.0.1', '192.168.1.2', '172.31.0.1', '169.254.1.2', '::1', 'fd00::1', 'fe80::1', 'bad'])('rejects invalid or internal address %s', ip => {
    expect(collectorContext({ ip, headers: {} } as Request)).toEqual({});
  });
  it('accepts the actual public IPv6 shopper address', () => {
    expect(collectorContext({ ip: '2606:4700:4700::1111', headers: {} } as Request)).toEqual({ clientIp: '2606:4700:4700::1111' });
  });
});
