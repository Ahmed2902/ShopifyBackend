import { decodeJwt, jwtVerify } from 'jose';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import type { StoreAccessClaim, StoreRoleClaim } from '../../../types/auth.js';
import { normalizeEmail } from '../../auth/auth.utils.js';
import { encryptSecret } from '../../integrations/integration.utils.js';
import { ShopifyRepository } from '../shopify.repository.js';
import { normalizeShopDomain } from '../shopify.utils.js';
import { ShopifyApiService } from './shopify-api.service.js';

const idTokenSecret = new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET);
const tokenExchangeSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  associated_user_scope: z.string().optional(),
  associated_user: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    email_verified: z.boolean().optional(),
    account_owner: z.boolean().optional(),
    collaborator: z.boolean().optional(),
    locale: z.string().nullable().optional(),
  }).optional(),
});

type ShopifyIdClaims = {
  dest: string;
  iss: string;
  sub: string;
};

export class ShopifyEmbeddedAuthService {
  private readonly repository = new ShopifyRepository();
  private readonly api = new ShopifyApiService(this.repository);

  looksLikeShopifyIdToken(token: string) {
    if (!env.SHOPIFY_EMBEDDED_AUTH_ENABLED) return false;
    try {
      const payload = decodeJwt(token);
      return payload.aud === env.SHOPIFY_CLIENT_ID && typeof payload.dest === 'string';
    } catch {
      return false;
    }
  }

  async authenticate(token: string): Promise<{
    userId: string;
    stores: StoreAccessClaim[];
    shopifyUserId: string;
    shopDomain: string;
  }> {
    const claims = await this.verifyIdToken(token);
    const shopDomain = normalizeShopDomain(new URL(claims.dest).hostname);
    const online = await this.exchange(token, shopDomain, 'online');
    const associated = online.associated_user;
    if (!associated) {
      throw new AppError('Shopify did not return the authenticated staff user', 401, 'SHOPIFY_IDENTITY_MISSING');
    }
    if (associated.id !== claims.sub) {
      throw new AppError('Shopify user identity did not match the ID token', 401, 'SHOPIFY_IDENTITY_MISMATCH');
    }

    let store = await prisma.store.findUnique({
      where: { myshopifyDomain: shopDomain },
      select: { id: true, shopifyConnection: { select: { status: true } } },
    });

    const user = await this.resolveInternalUser({
      storeId: store?.id,
      shopDomain,
      shopifyUserId: associated.id,
      email: associated.email ?? null,
      name: [associated.first_name, associated.last_name].filter(Boolean).join(' ') || null,
    });

    if (!store || !store.shopifyConnection || store.shopifyConnection.status === 'UNINSTALLED') {
      const offline = await this.exchange(token, shopDomain, 'offline');
      if (!offline.refresh_token || !offline.expires_in || !offline.refresh_token_expires_in) {
        throw new AppError('Shopify did not return an expiring offline token set', 502, 'SHOPIFY_TOKEN_EXCHANGE_FAILED');
      }
      const profile = await this.api.fetchShopProfile(shopDomain, offline.access_token, env.SHOPIFY_API_VERSION);
      const connected = await this.repository.connectStore({
        userId: user.id,
        profile,
        canonicalDomain: shopDomain,
        credentials: {
          accessTokenCiphertext: encryptSecret(offline.access_token),
          accessTokenExpiresAt: new Date(Date.now() + offline.expires_in * 1000),
          refreshTokenCiphertext: encryptSecret(offline.refresh_token),
          refreshTokenExpiresAt: new Date(Date.now() + offline.refresh_token_expires_in * 1000),
          scopes: offline.scope.split(',').map((scope) => scope.trim()).filter(Boolean),
        },
        apiVersion: env.SHOPIFY_API_VERSION,
      });
      if (!connected) {
        throw new AppError('Shopify store ownership could not be established', 403, 'SHOPIFY_STORE_OWNERSHIP_CONFLICT');
      }
      store = { id: connected.id, shopifyConnection: { status: 'ACTIVE' } };
    }

    const role: StoreRoleClaim = associated.account_owner ? 'OWNER' : 'MEMBER';
    await prisma.$transaction(async (tx) => {
      await tx.storeMembership.upsert({
        where: { userId_storeId: { userId: user.id, storeId: store!.id } },
        create: { userId: user.id, storeId: store!.id, role },
        update: associated.account_owner ? { role: 'OWNER' } : {},
      });
      await tx.shopifyUserIdentity.upsert({
        where: { storeId_shopifyUserId: { storeId: store!.id, shopifyUserId: associated.id } },
        create: {
          storeId: store!.id,
          userId: user.id,
          shopifyUserId: associated.id,
          email: associated.email ?? null,
          name: [associated.first_name, associated.last_name].filter(Boolean).join(' ') || null,
          accountOwner: associated.account_owner ?? false,
          collaborator: associated.collaborator ?? false,
          locale: associated.locale ?? null,
          lastAuthenticatedAt: new Date(),
        },
        update: {
          userId: user.id,
          email: associated.email ?? null,
          name: [associated.first_name, associated.last_name].filter(Boolean).join(' ') || null,
          accountOwner: associated.account_owner ?? false,
          collaborator: associated.collaborator ?? false,
          locale: associated.locale ?? null,
          lastAuthenticatedAt: new Date(),
        },
      });
    });

    const membership = await prisma.storeMembership.findUniqueOrThrow({
      where: { userId_storeId: { userId: user.id, storeId: store.id } },
      select: { role: true },
    });
    return {
      userId: user.id,
      stores: [{ storeId: store.id, role: membership.role }],
      shopifyUserId: associated.id,
      shopDomain,
    };
  }

  private async verifyIdToken(token: string): Promise<ShopifyIdClaims> {
    try {
      const { payload } = await jwtVerify(token, idTokenSecret, {
        algorithms: ['HS256'],
        audience: env.SHOPIFY_CLIENT_ID,
      });
      if (typeof payload.dest !== 'string' || typeof payload.iss !== 'string' || !payload.sub) {
        throw new Error('Required Shopify ID token claims are missing');
      }
      const dest = new URL(payload.dest);
      const issuer = new URL(payload.iss);
      if (dest.hostname !== issuer.hostname) throw new Error('Shopify issuer/destination mismatch');
      normalizeShopDomain(dest.hostname);
      return { dest: payload.dest, iss: payload.iss, sub: payload.sub };
    } catch {
      throw new AppError('Invalid or expired Shopify ID token', 401, 'SHOPIFY_ID_TOKEN_INVALID');
    }
  }

  private async exchange(idToken: string, shop: string, kind: 'online' | 'offline') {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: kind === 'online'
          ? 'urn:shopify:params:oauth:token-type:online-access-token'
          : 'urn:shopify:params:oauth:token-type:offline-access-token',
        ...(kind === 'offline' ? { expiring: '1' } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 400) {
      throw new AppError('Shopify ID token must be refreshed', 401, 'SHOPIFY_ID_TOKEN_INVALID');
    }
    if (!response.ok) {
      throw new AppError('Shopify token exchange failed', 502, 'SHOPIFY_TOKEN_EXCHANGE_FAILED');
    }
    const parsed = tokenExchangeSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AppError('Shopify token exchange returned an unexpected response', 502, 'SHOPIFY_BAD_RESPONSE');
    }
    return parsed.data;
  }

  private async resolveInternalUser(input: {
    storeId?: string;
    shopDomain: string;
    shopifyUserId: string;
    email: string | null;
    name: string | null;
  }) {
    if (input.storeId) {
      const identity = await prisma.shopifyUserIdentity.findUnique({
        where: { storeId_shopifyUserId: { storeId: input.storeId, shopifyUserId: input.shopifyUserId } },
        select: { user: { select: { id: true } } },
      });
      if (identity) return identity.user;
    }

    const email = input.email
      ? normalizeEmail(input.email)
      : `shopify-${input.shopifyUserId}-${input.shopDomain.replace(/[^a-z0-9]+/g, '-')}@identity.invalid`;
    return prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: input.name,
        emailVerifiedAt: input.email ? new Date() : null,
      },
      update: input.name ? { name: input.name } : {},
      select: { id: true },
    });
  }
}

export const shopifyEmbeddedAuthService = new ShopifyEmbeddedAuthService();
