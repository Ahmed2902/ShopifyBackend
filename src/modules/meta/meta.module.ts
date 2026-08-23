import { IntegrationRepository } from '../integrations/integration.repository.js';
import { IntegrationService } from '../integrations/integration.service.js';
import { MetaAdsRepository } from './ads/meta-ads.repository.js';
import { MetaAdsService } from './ads/meta-ads.service.js';
import { MetaCatalogRepository } from './catalog/meta-catalog.repository.js';
import { MetaCatalogService } from './catalog/meta-catalog.service.js';
import { MetaInsightsRepository } from './insights/meta-insights.repository.js';
import { MetaInsightsService } from './insights/meta-insights.service.js';
import { MetaRepository } from './meta.repository.js';
import { MetaService } from './meta.service.js';
import { MetaApiService } from './shared/meta-api.service.js';
import { MetaAuthService } from './shared/meta-auth.service.js';

const metaRepository = new MetaRepository();
const metaApiService = new MetaApiService(metaRepository);
const metaAuthService = new MetaAuthService(metaRepository, metaApiService);
const metaAdsRepository = new MetaAdsRepository();
const metaAdsService = new MetaAdsService(metaAdsRepository, metaApiService);
const metaCatalogRepository = new MetaCatalogRepository();
const metaCatalogService = new MetaCatalogService(metaCatalogRepository, metaApiService);
const metaInsightsRepository = new MetaInsightsRepository();
const metaInsightsService = new MetaInsightsService(metaInsightsRepository, metaApiService);
const integrationService = new IntegrationService(new IntegrationRepository());

export const metaService = new MetaService(
  metaRepository,
  metaAuthService,
  metaApiService,
  metaAdsService,
  metaAdsRepository,
  integrationService,
  metaCatalogService,
  metaCatalogRepository,
  metaInsightsService,
  metaInsightsRepository,
);
