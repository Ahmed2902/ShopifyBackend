import { integrationService } from '../integrations/integration.module.js';
import { MetaAdsRepository } from './ads/meta-ads.repository.js';
import { MetaAdsService } from './ads/meta-ads.service.js';
import { MetaCatalogRepository } from './catalog/meta-catalog.repository.js';
import { MetaCatalogService } from './catalog/meta-catalog.service.js';
import { MetaInsightsRepository } from './insights/meta-insights.repository.js';
import { MetaInsightsService } from './insights/meta-insights.service.js';
import { MetaMappingRepository } from './mapping/meta-mapping.repository.js';
import { MetaMappingService } from './mapping/meta-mapping.service.js';
import { MetaRepository } from './meta.repository.js';
import { MetaService } from './meta.service.js';
import { MetaApiService } from './shared/meta-api.service.js';
import { MetaAuthService } from './shared/meta-auth.service.js';

const metaRepository = new MetaRepository();
const metaApiService = new MetaApiService(metaRepository);
const metaAdsService = new MetaAdsService(new MetaAdsRepository(), metaApiService);
const metaCatalogService = new MetaCatalogService(new MetaCatalogRepository(), metaApiService);
const metaInsightsService = new MetaInsightsService(new MetaInsightsRepository(), metaApiService);

export const metaMappingService = new MetaMappingService(
  new MetaMappingRepository(),
  integrationService,
);

export const metaService = new MetaService(
  metaRepository,
  new MetaAuthService(metaRepository, metaApiService),
  metaApiService,
  metaAdsService,
  integrationService,
  metaCatalogService,
  metaInsightsService,
);
