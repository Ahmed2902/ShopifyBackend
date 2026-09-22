// Compatibility bridge for the MCP/business-knowledge branch.
// The provider abstraction now belongs to src/modules/advertising so analytics,
// intelligence, HTTP reads, and MCP can converge on one registry.
export {
  AdvertisingProviderRegistry as PaidMediaEvidenceRegistry,
  MetaAdvertisingEvidenceProvider as MetaPaidMediaEvidenceProvider,
  TikTokAdvertisingEvidenceProvider as TikTokPaidMediaEvidenceProvider,
  advertisingProviderRegistry as paidMediaEvidenceRegistry,
} from '../advertising/advertising.provider.js';

export type {
  AdvertisingEvidenceProvider as PaidMediaEvidenceProvider,
  PaidMediaLevel,
  PaidMediaProviderCapabilities,
  PaidMediaReadQuery,
} from '../advertising/advertising.provider.js';

export type { AdvertisingPlatform as PaidMediaProvider } from '../advertising/advertising.types.js';
