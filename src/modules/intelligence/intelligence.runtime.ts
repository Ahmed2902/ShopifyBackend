import { CanonicalCreativeVideoRetentionService } from '../analytics/canonical-creative-video-retention.service.js';
import { CanonicalIntelligenceRepository } from './canonical-intelligence.repository.js';
import { IntelligenceAdSetReadRepository } from './intelligence-adset.read.repository.js';
import { IntelligenceAttributionHealthReadRepository } from './intelligence-attribution-health.read.repository.js';
import { IntelligenceCommerceHealthReadRepository } from './intelligence-commerce-health.read.repository.js';
import { IntelligenceCommerceReadRepository } from './intelligence-commerce.read.repository.js';
import { IntelligenceContextReadRepository } from './intelligence-context.read.repository.js';
import { IntelligenceService } from './intelligence.service.js';
import { IntelligenceSharedExposureReadRepository } from './intelligence-shared-exposure.read.repository.js';
import { IntelligenceStorefrontReadRepository } from './intelligence-storefront.read.repository.js';

/** Production runtime: canonical paid-media evidence with current compatibility DTOs. */
export const intelligenceRuntimeService = new IntelligenceService(
  new CanonicalIntelligenceRepository(),
  new IntelligenceCommerceReadRepository(),
  new IntelligenceSharedExposureReadRepository(),
  new IntelligenceContextReadRepository(),
  new IntelligenceStorefrontReadRepository(),
  new IntelligenceCommerceHealthReadRepository(),
  new CanonicalCreativeVideoRetentionService(),
  new IntelligenceAdSetReadRepository(),
  new IntelligenceAttributionHealthReadRepository(),
);
