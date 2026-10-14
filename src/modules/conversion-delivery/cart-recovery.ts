import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/app-error.js';
import { loadRoutingSummaries, routingKey } from './source-routing.js';

const RECEIPT_DAYS = 14;
const claimsSchema = z.object({ v: z.literal(1), storeId: z.uuid(), eventId: z.uuid(),
  generation: z.iso.datetime(), cartHash: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().int() });
export const cartRecoverySchema = z.object({ installationId: z.uuid(), collectorToken: z.string().min(16).max(256),
  eventIds: z.array(z.string().min(1).max(255)).min(1).max(20), cartToken: z.string().min(16).max(1024) }).strict();
export function cartProofHash(storeId: string, token: string | null | undefined) {
  const canonical = token?.split('?')[0];
  if (!canonical || !/^[A-Za-z0-9_-]{16,256}$/.test(canonical)) return null;
  return createHash('sha256').update(JSON.stringify(['metrico-cart-v1', storeId, canonical])).digest('hex');
}
function signature(body: string) {
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update('metrico-cart-recovery-v1:' + body).digest('base64url');
}
export function signCartReceipt(input: z.infer<typeof claimsSchema>) {
  const body = Buffer.from(JSON.stringify(claimsSchema.parse(input))).toString('base64url');
  return body + '.' + signature(body);
}
export function verifyCartReceipt(value: string | undefined, storeId: string, cartToken: string | null | undefined, now = Date.now()) {
  if (!value || value.length > 2048) return null;
  const [body, sig, extra] = value.split('.');
  if (!body || !sig || extra) return null;
  const actual = Buffer.from(sig), expected = Buffer.from(signature(body));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const c = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (c.storeId !== storeId || c.cartHash !== cartProofHash(storeId, cartToken) || c.expires <= now) return null;
    return c;
  } catch { return null; }
}

export async function authorizeCartRecovery(input: z.infer<typeof cartRecoverySchema>) {
  const now = new Date();
  const installation = await prisma.pixelInstallation.findUnique({ where: { id: input.installationId } });
  const hash = createHash('sha256').update(input.collectorToken).digest('hex');
  const valid = installation && [installation.collectorTokenHash, installation.pendingCollectorTokenHash].some(h => {
    if (!h || h.length !== hash.length) return false;
    return timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  });
  if (!installation || installation.status !== 'ACTIVE' || !valid)
    throw new AppError('Pixel collector credentials are invalid', 401, 'PIXEL_UNAUTHORIZED');
  const cartHash = cartProofHash(installation.storeId, input.cartToken);
  if (!cartHash) throw new AppError('Cart proof is invalid', 400, 'CART_PROOF_INVALID');
  const rows = await prisma.$queryRaw<Array<{ id: string; generation: Date }>>`
    SELECT e.id, c."installedAt" AS generation FROM "StorefrontEvent" e
    JOIN "ShopifyConnection" c ON c."storeId" = e."storeId" AND c.status = 'ACTIVE'
    WHERE e."storeId" = ${installation.storeId}::uuid AND e."eventId" = ANY(${input.eventIds}::text[])
      AND e."adSharingAllowed" = TRUE AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
      AND e."eventAt" >= c."installedAt" AND e."receivedAt" >= c."installedAt"
      AND e."receivedAt" BETWEEN ${new Date(now.getTime() - 60_000)} AND ${now}
      AND e."retentionExpiresAt" > ${now}
      AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId"
        AND w."revokedBefore" >= LEAST(e."eventAt", e."receivedAt")
        AND (w."scopeKey" = 'session:' || e."sessionId" OR w."scopeKey" = 'visitor:' || e."anonymousVisitorId"))
      AND NOT EXISTS (SELECT 1 FROM "StorefrontEvent" later WHERE later."storeId" = e."storeId"
        AND (later."sessionId" = e."sessionId" OR (e."anonymousVisitorId" IS NOT NULL AND later."anonymousVisitorId" = e."anonymousVisitorId"))
        AND later."receivedAt" > e."receivedAt" AND later."adSharingAllowed" = FALSE)
    ORDER BY e."receivedAt" DESC LIMIT 1`;
  const event = rows[0];
  if (!event) return { receipt: null };
  const routeInput = { storeId: installation.storeId, sourceEventId: event.id,
    sourceGenerationAt: event.generation, eventAt: new Date(now.getTime() + 5000) };
  const routes = await loadRoutingSummaries([routeInput]);
  // A direct/organic observation must not replace a valid earlier paid-touch cart receipt.
  if (!routes.get(routingKey(routeInput))?.eligibleProviders.length) return { receipt: null };
  return { receipt: signCartReceipt({ v: 1, storeId: installation.storeId, eventId: event.id,
    generation: event.generation.toISOString(), cartHash, expires: now.getTime() + RECEIPT_DAYS * 86400_000 }) };
}
