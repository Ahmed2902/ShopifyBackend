import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

export type CollectorContext = { clientIp?: string };

// Conservative public-unicast policy from IANA's special-purpose registries:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Special-purpose/transition addresses are omitted even where a narrow anycast
// exception is reachable; they are not dependable ordinary shopper addresses.
const excludedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) excludedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const excludedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  excludedV6.addSubnet(address, prefix, 'ipv6');

export function publicClientIp(address: string | null | undefined) {
  const value = address?.replace(/^::ffff:/i, '');
  if (!value || value.includes('%')) return undefined;
  const family = isIP(value);
  if (family === 4) return excludedV4.check(value, 'ipv4') ? undefined : value;
  if (family === 6 && globalV6.check(value, 'ipv6') && !excludedV6.check(value, 'ipv6')) return value;
  return undefined;
}

export function collectorContext(req: Request): CollectorContext {
  // Express resolves this using the app's configured trusted ingress chain. Never
  // pick an arbitrary X-Forwarded-For element or accept an IP from the JSON body.
  if (req.headers['x-forwarded-for'] && !req.ips?.length) return {};
  const value = publicClientIp(req.ip);
  return value ? { clientIp: value } : {};
}
