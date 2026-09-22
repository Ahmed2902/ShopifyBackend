# Advertising provider architecture

Stride normalizes the paid-media entities it actually reasons about into one canonical persistence model while preserving provider-specific payloads and capabilities.

## Boundary

```text
Meta API ------\
TikTok API -----> provider adapter -> canonical advertising tables -> analytics / intelligence / MCP
Google API ----/        |                         |
                        |                         +-> shared campaign/group/ad/metric/product evidence
                        +-> providerData/rawJson preserve native fields
```

Provider adapters translate platform-specific API objects and semantics into Stride's common paid-media language. The normalized model preserves provider identity, attribution limitations, currency policy, and capability differences rather than pretending every network has identical features.

## Registry

`AdvertisingProviderRegistry` is the application-level lookup for provider behavior. Consumers do not scatter `if META / if TIKTOK / if GOOGLE` branches throughout the codebase.

The first registry implementations are:

- `MetaAdvertisingEvidenceProvider`
- `TikTokAdvertisingEvidenceProvider`

The existing `business-knowledge/paid-media-evidence.ts` module is temporarily retained as a compatibility re-export while MCP hardening is under QA.

## Canonical persistence

The shared model is intentionally limited to concepts that map cleanly across the major ad networks:

- `AdvertisingAccount`
- `AdvertisingCampaign`
- `AdvertisingGroup` (`AD_SET` for Meta, `AD_GROUP` for TikTok/standard Google groups, `ASSET_GROUP` for Google Performance Max)
- `AdvertisingAd`
- `AdvertisingCreative` where the provider exposes stable creative identity
- `AdvertisingDailyMetric`
- `AdvertisingProductMapping`
- `AdvertisingCollectionMapping`

`AdvertisingAccount.provider` identifies the network. Child entities inherit provider identity through their account relation, avoiding redundant provider columns that could disagree with the parent.

Every canonical provider entity keeps `providerEntityId` (the ID assigned by Meta/TikTok/Google), while Stride keeps its UUID as the primary key. During migration, existing Meta/TikTok UUIDs are preserved in the canonical tables so current recommendation/entity references do not churn.

`providerData` stores provider-specific structured fields that Stride may need but that do not justify universal columns. `rawJson` retains the native source payload for audit/debugging. Google Performance Max asset groups fit the canonical hierarchy directly as `AdvertisingGroup(kind = ASSET_GROUP)`; only concepts that genuinely do not fit that shared hierarchy (for example listing-group filters or provider-only asset metadata) may use focused extension tables instead of creating a parallel Google schema or polluting common tables with mostly-null columns.

## Migration policy

Migration is additive first:

1. Create canonical advertising tables.
2. Backfill existing Meta and TikTok hierarchy, common metrics, and product mappings while preserving UUIDs.
3. Dual-write provider syncs into native + canonical tables.
4. Prove canonical reads match current production behavior.
5. Move analytics, Product x Ads, intelligence, recommendation entity resolution, and MCP reads to canonical persistence.
6. Remove obsolete provider-native duplicate tables only after parity and rollback windows are complete.

Provider-native tables remain the compatibility source during this transition; they are not dropped in the initial migration.

### Current checkpoint

Canonical tables, additive backfill, Meta/TikTok hierarchy synchronization, common daily facts, target-scope/product mapping projection, and cascade cleanup are implemented. Historical Meta daily facts are also normalized with the same purchase-action priority and ROAS fallback semantics used by live ingestion, so a later read cutover does not lose pre-migration purchase evidence. Production analytics/intelligence/MCP reads intentionally remain on their existing sources until parity tests prove the canonical model returns equivalent Meta behavior and the expected TikTok semantics.

The read cutover is a separate compatibility step: schema migration and dual-write can ship without changing decision output. Canonical reads should replace native reads only after parity coverage verifies entity identity, date windows, currency handling, provider conversion semantics, mapping history, and soft-delete behavior.

### Safety rules

- Canonical rows are derived store data and cascade on physical store/account/ad deletion so they cannot block Shopify privacy cleanup.
- Provider-native UUIDs are preserved when projected into canonical rows, keeping existing internal entity references stable during cutover.
- Native and canonical writes are transactional where practical; Meta hierarchy uses a set-based projection only after the full provider snapshot and tombstones succeed.
- Numeric provider/native representations such as Prisma decimals are normalized at the canonical write boundary.
- Provider-specific source tables remain available until canonical parity and rollback requirements are satisfied.

## Metrics and attribution

`AdvertisingDailyMetric` is the cross-provider fact table for common measures such as spend, impressions, clicks, provider conversions/value, CTR, CPC, CPM, CPA and ROAS.

Provider conversion/value fields remain provider-reported attribution, never Shopify purchase truth. Detailed provider semantics stay in `providerMetrics`/`rawJson` so normalization does not erase differences such as Meta action arrays or Google conversion-action configuration.

- Shopify remains commerce/revenue truth.
- Cross-provider spend may be combined only when currencies are compatible.
- Provider-attributed conversion value must not be summed as if it were unique Shopify revenue.
- Meta budget minor units are not blindly divided by 100; canonical major-unit budget fields are populated only when the provider adapter can normalize the account currency safely.

## Connection migration

OAuth/token persistence is deliberately not duplicated in the first canonical-data migration. `MetaConnection` and `TikTokConnection` remain in place while the shared hierarchy is proven. A later connection migration can introduce a single `AdvertisingConnection` without temporarily copying encrypted credentials into multiple tables.

## Follow-up

1. Add parity tests against canonical reads.
2. Switch shared analytics and Product x Ads to canonical persistence.
3. Move deterministic intelligence/data-quality/recommendation entity resolution to canonical persistence.
4. Point MCP at the same canonical read layer.
5. Add Google Ads directly against the canonical model, mapping Performance Max asset groups to `AdvertisingGroup(kind = ASSET_GROUP)` and using focused extension data only for provider-only concepts.
6. Remove obsolete provider-native duplicate tables only after parity and rollback windows are complete.

This PR stops at the persistence/dual-write boundary; canonical read cutover is intentionally deferred to the next isolated slice so any change in decision output can be attributed to read semantics rather than schema migration.
