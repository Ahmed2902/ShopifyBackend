import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PixelJourneyService } from '../../../src/modules/pixel/journey/pixel-journey.service.js';
import type { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
import { PixelService } from '../../../src/modules/pixel/pixel.service.js';
import type { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixedNow = new Date('2026-09-04T12:00:00.000Z');

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function buildService(updatedAt: Date) {
  const collectorToken = 'R'.repeat(43);
  const installation = {
    id: installationId,
    storeId,
    shopifyWebPixelId: null,
    status: 'PROVISIONING',
    installedAt: null,
    lastError: null,
    pendingCollectorTokenHash: tokenHash(collectorToken),
    updatedAt,
  };

  const repository = {
    findInstallationForProvisioning: vi.fn().mockResolvedValue(installation),
    finalizeInstallation: vi.fn().mockResolvedValue({
      id: installationId,
      storeId,
      collectorTokenPrefix: collectorToken.slice(0, 8),
      shopifyWebPixelId: 'gid://shopify/WebPixel/42',
      status: 'ACTIVE',
      installedAt: fixedNow,
      lastEventAt: null,
      lastError: null,
      updatedAt: fixedNow,
    }),
    rollbackStagedInstallation: vi.fn(),
    stageInstallation: vi.fn(),
  } as unknown as PixelRepository;

  const shopifyProvisioner = {
    inspect: vi.fn().mockResolvedValue({
      id: 'gid://shopify/WebPixel/42',
      settings: {
        installationId,
        collectorToken,
        collectorUrl: 'http://localhost:3001/v1/pixel/events',
      },
    }),
    upsert: vi.fn(),
  } as unknown as ShopifyPixelProvisioner;

  const journeyService = {} as PixelJourneyService;
  return {
    repository,
    shopifyProvisioner,
    service: new PixelService(repository, shopifyProvisioner, () => fixedNow, journeyService),
  };
}

describe('Pixel stale provisioning recovery', () => {
  it('reconciles a provider-accepted pending token even when local error recording never succeeded', async () => {
    const { repository, shopifyProvisioner, service } = buildService(
      new Date('2026-09-04T11:40:00.000Z'),
    );

    await expect(service.installShopifyPixel(storeId)).resolves.toMatchObject({
      status: 'ACTIVE',
      shopifyWebPixelId: 'gid://shopify/WebPixel/42',
    });

    expect(shopifyProvisioner.inspect).toHaveBeenCalledWith(storeId);
    expect(repository.finalizeInstallation).toHaveBeenCalledWith({
      id: installationId,
      expectedPendingTokenHash: tokenHash('R'.repeat(43)),
      shopifyWebPixelId: 'gid://shopify/WebPixel/42',
      installedAt: fixedNow,
    });
    expect(repository.stageInstallation).not.toHaveBeenCalled();
    expect(shopifyProvisioner.upsert).not.toHaveBeenCalled();
  });

  it('does not steal a fresh in-flight provisioning operation', async () => {
    const { repository, shopifyProvisioner, service } = buildService(
      new Date('2026-09-04T11:55:00.000Z'),
    );

    await expect(service.installShopifyPixel(storeId)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PIXEL_INSTALLATION_IN_PROGRESS',
    });

    expect(shopifyProvisioner.inspect).not.toHaveBeenCalled();
    expect(repository.finalizeInstallation).not.toHaveBeenCalled();
  });
});