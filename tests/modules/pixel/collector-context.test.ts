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
  it.each(['0.0.0.1', '127.0.0.1', '10.0.0.1', '192.168.1.2', '172.31.0.1', '169.254.1.2',
    '100.64.0.1', '100.127.255.254', '192.0.0.8', '192.0.2.1', '192.88.99.2', '198.18.0.1', '198.19.255.254',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001:2::1', '2002::1', '3fff::1',
    '100::1', '100:0:0:1::1', '5f00::1', '64:ff9b:1::1', '::ffff:100.64.0.1', 'bad'])('rejects invalid or non-public address %s', ip => {
    expect(collectorContext({ ip, headers: {} } as Request)).toEqual({});
  });
  it('accepts the actual public IPv6 shopper address', () => {
    expect(collectorContext({ ip: '2606:4700:4700::1111', headers: {} } as Request)).toEqual({ clientIp: '2606:4700:4700::1111' });
  });
  it.each(['100.63.255.254', '100.128.0.1', '198.17.255.254', '198.20.0.1', '2001:4860:4860::8888', '::ffff:8.8.4.4'])('preserves an ordinary public address at boundary %s', ip => {
    expect(collectorContext({ ip, headers: {} } as Request).clientIp).toBe(ip.replace(/^::ffff:/i, ''));
  });
});
