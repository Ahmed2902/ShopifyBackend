import { isIP } from 'node:net';
import type { Request } from 'express';

export type CollectorContext = { clientIp?: string };

export function collectorContext(req: Request): CollectorContext {
  // Express resolves this using the app's configured trusted ingress chain. Never
  // pick an arbitrary X-Forwarded-For element or accept an IP from the JSON body.
  if (req.headers['x-forwarded-for'] && !req.ips?.length) return {};
  const value = req.ip?.replace(/^::ffff:/i, '');
  if (!value || !isIP(value)) return {};
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a! >= 224 ||
        (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
        (a === 192 && b === 168)) return {};
  } else if (/^(::|fc|fd|fe[89ab])/i.test(value)) return {};
  return { clientIp: value };
}
