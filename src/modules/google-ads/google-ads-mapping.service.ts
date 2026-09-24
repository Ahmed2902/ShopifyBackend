import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { deterministicUuid } from './google-ads.utils.js';

const PRODUCT_PATH = /(?:^|\/)products\/([^/?#]+)/i;
const COLLECTION_PATH = /(?:^|\/)collections\/([^/?#]+)/i;

function normalizeHost(host: string) {
  return host.toLowerCase().replace(/^www\./, '');
}

function numericTail(value: string) {
  return value.match(/(\d+)$/)?.[1] ?? value;
}

function parseStoreUrl(rawUrl: string, hosts: Set<string>) {
  try {
    const url = new URL(rawUrl);
    if (!hosts.has(normalizeHost(url.hostname))) return { kind: 'EXTERNAL' as const };
    const productHandle = url.pathname.match(PRODUCT_PATH)?.[1];
    if (productHandle) {
      return {
        kind: 'PRODUCT' as const,
        handle: decodeURIComponent(productHandle).toLowerCase(),
        variant: url.searchParams.get('variant'),
      };
    }
    const collectionHandle = url.pathname.match(COLLECTION_PATH)?.[1];
    if (collectionHandle) {
      return {
        kind: 'COLLECTION' as const,
        handle: decodeURIComponent(collectionHandle).toLowerCase(),
      };
    }
    return { kind: 'OTHER' as const };
  } catch {
    return { kind: 'INVALID' as const };
  }
}

/**
 * Projects only deterministic Google final-URL evidence into canonical Product × Ads mappings.
 * PMax Asset Groups intentionally remain outside the adId-based mapping tables: Stride must not
 * fabricate an AdvertisingAd merely to allocate Shopping/PMax spend.
 */
export class GoogleAdsMappingService {
  async projectDeterministicFinalUrls(storeId: string) {
    const [store, ads, products, collections, confirmedProducts, confirmedCollections] =
      await Promise.all([
        prisma.store.findUnique({
          where: { id: storeId },
          select: { myshopifyDomain: true, primaryDomainHost: true },
        }),
        prisma.advertisingAd.findMany({
          where: {
            deletedAt: null,
            landingPageUrl: { not: null },
            account: { storeId, provider: 'GOOGLE_ADS' },
          },
          select: { id: true, landingPageUrl: true },
        }),
        prisma.product.findMany({
          where: { storeId, deletedAt: null, handle: { not: null } },
          select: {
            id: true,
            handle: true,
            variants: {
              where: { deletedAt: null },
              select: { id: true, shopifyVariantId: true },
            },
          },
        }),
        prisma.collection.findMany({
          where: { storeId, deletedAt: null, handle: { not: null } },
          select: { id: true, handle: true },
        }),
        prisma.advertisingProductMapping.findMany({
          where: {
            validUntil: null,
            isMerchantConfirmed: true,
            ad: { account: { storeId, provider: 'GOOGLE_ADS' } },
          },
          select: { adId: true },
          distinct: ['adId'],
        }),
        prisma.advertisingCollectionMapping.findMany({
          where: {
            validUntil: null,
            isMerchantConfirmed: true,
            ad: { account: { storeId, provider: 'GOOGLE_ADS' } },
          },
          select: { adId: true },
          distinct: ['adId'],
        }),
      ]);

    if (!store) return { productMappings: 0, collectionMappings: 0, unmappedAds: ads.length };

    const hosts = new Set(
      [store.myshopifyDomain, store.primaryDomainHost]
        .filter((value): value is string => Boolean(value))
        .map(normalizeHost),
    );
    const productsByHandle = new Map<string, typeof products>();
    for (const product of products) {
      const handle = product.handle?.toLowerCase();
      if (!handle) continue;
      const current = productsByHandle.get(handle) ?? [];
      current.push(product);
      productsByHandle.set(handle, current);
    }
    const collectionsByHandle = new Map<string, typeof collections>();
    for (const collection of collections) {
      const handle = collection.handle?.toLowerCase();
      if (!handle) continue;
      const current = collectionsByHandle.get(handle) ?? [];
      current.push(collection);
      collectionsByHandle.set(handle, current);
    }
    const protectedAdIds = new Set([
      ...confirmedProducts.map((mapping) => mapping.adId),
      ...confirmedCollections.map((mapping) => mapping.adId),
    ]);

    const now = new Date();
    let productMappings = 0;
    let collectionMappings = 0;
    let unmappedAds = 0;

    await prisma.$transaction(async (tx) => {
      await tx.advertisingProductMapping.updateMany({
        where: {
          validUntil: null,
          source: 'LANDING_PAGE',
          isMerchantConfirmed: false,
          ad: { account: { storeId, provider: 'GOOGLE_ADS' } },
        },
        data: { validUntil: now },
      });
      await tx.advertisingCollectionMapping.updateMany({
        where: {
          validUntil: null,
          source: 'LANDING_PAGE',
          isMerchantConfirmed: false,
          ad: { account: { storeId, provider: 'GOOGLE_ADS' } },
        },
        data: { validUntil: now },
      });
      await tx.advertisingAd.updateMany({
        where: {
          id: { in: ads.map((ad) => ad.id), notIn: [...protectedAdIds] },
          account: { storeId, provider: 'GOOGLE_ADS' },
        },
        data: {
          targetScope: 'UNKNOWN',
          targetScopeConfidence: null,
          targetScopeEvidence: Prisma.DbNull,
        },
      });

      for (const ad of ads) {
        if (!ad.landingPageUrl) continue;
        const parsed = parseStoreUrl(ad.landingPageUrl, hosts);
        if (parsed.kind === 'PRODUCT') {
          const candidates = productsByHandle.get(parsed.handle) ?? [];
          if (candidates.length !== 1) {
            unmappedAds += 1;
            continue;
          }
          const product = candidates[0]!;
          let variantId: string | null = null;
          if (parsed.variant) {
            const requested = numericTail(parsed.variant);
            const variants = product.variants.filter(
              (variant) => numericTail(variant.shopifyVariantId) === requested,
            );
            if (variants.length !== 1) {
              unmappedAds += 1;
              continue;
            }
            variantId = variants[0]!.id;
          }
          const mappingId = deterministicUuid(
            'GOOGLE_ADS_PRODUCT_MAPPING',
            ad.id,
            product.id,
            variantId ?? 'PRODUCT',
          );
          await tx.advertisingProductMapping.upsert({
            where: { id: mappingId },
            create: {
              id: mappingId,
              adId: ad.id,
              productId: product.id,
              variantId,
              granularity: variantId ? 'VARIANT' : 'PRODUCT',
              source: 'LANDING_PAGE',
              confidence: new Prisma.Decimal(1),
              evidenceJson: {
                provider: 'GOOGLE_ADS',
                matchedBy: variantId ? 'SHOPIFY_PRODUCT_VARIANT_URL' : 'SHOPIFY_PRODUCT_URL',
                url: ad.landingPageUrl,
              },
              landingUrl: ad.landingPageUrl,
              providerData: { provider: 'GOOGLE_ADS', deterministic: true },
              validFrom: now,
            },
            update: {
              variantId,
              granularity: variantId ? 'VARIANT' : 'PRODUCT',
              confidence: new Prisma.Decimal(1),
              evidenceJson: {
                provider: 'GOOGLE_ADS',
                matchedBy: variantId ? 'SHOPIFY_PRODUCT_VARIANT_URL' : 'SHOPIFY_PRODUCT_URL',
                url: ad.landingPageUrl,
              },
              landingUrl: ad.landingPageUrl,
              providerData: { provider: 'GOOGLE_ADS', deterministic: true },
              validUntil: null,
            },
          });
          if (!protectedAdIds.has(ad.id)) {
            await tx.advertisingAd.update({
              where: { id: ad.id },
              data: {
                targetScope: variantId ? 'VARIANT' : 'PRODUCT',
                targetScopeConfidence: new Prisma.Decimal(1),
                targetScopeEvidence: {
                  provider: 'GOOGLE_ADS',
                  matchedBy: 'LANDING_PAGE',
                  url: ad.landingPageUrl,
                },
              },
            });
          }
          productMappings += 1;
          continue;
        }

        if (parsed.kind === 'COLLECTION') {
          const candidates = collectionsByHandle.get(parsed.handle) ?? [];
          if (candidates.length !== 1) {
            unmappedAds += 1;
            continue;
          }
          const collection = candidates[0]!;
          const mappingId = deterministicUuid(
            'GOOGLE_ADS_COLLECTION_MAPPING',
            ad.id,
            collection.id,
          );
          await tx.advertisingCollectionMapping.upsert({
            where: { id: mappingId },
            create: {
              id: mappingId,
              adId: ad.id,
              collectionId: collection.id,
              source: 'LANDING_PAGE',
              confidence: new Prisma.Decimal(1),
              evidenceJson: {
                provider: 'GOOGLE_ADS',
                matchedBy: 'SHOPIFY_COLLECTION_URL',
                url: ad.landingPageUrl,
              },
              landingUrl: ad.landingPageUrl,
              providerData: { provider: 'GOOGLE_ADS', deterministic: true },
              validFrom: now,
            },
            update: {
              confidence: new Prisma.Decimal(1),
              evidenceJson: {
                provider: 'GOOGLE_ADS',
                matchedBy: 'SHOPIFY_COLLECTION_URL',
                url: ad.landingPageUrl,
              },
              landingUrl: ad.landingPageUrl,
              providerData: { provider: 'GOOGLE_ADS', deterministic: true },
              validUntil: null,
            },
          });
          if (!protectedAdIds.has(ad.id)) {
            await tx.advertisingAd.update({
              where: { id: ad.id },
              data: {
                targetScope: 'COLLECTION',
                targetScopeConfidence: new Prisma.Decimal(1),
                targetScopeEvidence: {
                  provider: 'GOOGLE_ADS',
                  matchedBy: 'LANDING_PAGE',
                  url: ad.landingPageUrl,
                },
              },
            });
          }
          collectionMappings += 1;
          continue;
        }

        unmappedAds += 1;
      }
    });

    return { productMappings, collectionMappings, unmappedAds };
  }
}

export const googleAdsMappingService = new GoogleAdsMappingService();
