import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { PixelAttributionController } from '../../../src/modules/pixel/attribution/pixel-attribution.controller.js';
import type { PixelAttributionService } from '../../../src/modules/pixel/attribution/pixel-attribution.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Pixel attribution account scope', () => {
  it('fails closed instead of pretending store-scoped attribution is account-scoped', async () => {
    const service = {
      sources: vi.fn(),
      metaAds: vi.fn(),
      paths: vi.fn(),
      mappingEvidence: vi.fn(),
    } as unknown as PixelAttributionService;
    const controller = new PixelAttributionController(service);
    const req = {
      query: { accountId: 'act_202' },
      context: { storeId },
    } as unknown as Request;

    await expect(controller.sources(req, {} as Response)).rejects.toMatchObject({
      code: 'ACCOUNT_SCOPED_ATTRIBUTION_UNSUPPORTED',
      statusCode: 400,
    });
    expect(service.sources).not.toHaveBeenCalled();
  });
});
