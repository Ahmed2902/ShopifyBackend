import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSINESS_KNOWLEDGE_CATALOG } from '../../../src/modules/business-knowledge/business-knowledge.catalog.js';

describe('production correctness repair contracts', () => {
  it('keeps the TikTok historical conversion-value correction narrowly scoped to legacy native rows', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260924000100_fix_tiktok_canonical_conversion_value/migration.sql',
      ),
      'utf8',
    );

    expect(sql).toContain(`account."provider" = 'TIKTOK'::"AdvertisingProvider"`);
    expect(sql).toContain('native."conversionValue" IS NOT NULL');
    expect(sql).toContain('metric."conversionValue" IS NOT NULL');
    expect(sql).toContain("metric.\"metricKey\" = 'TIKTOK:' || native.\"insightKey\"");
    expect(sql).toContain("'legacyTotalCompletePaymentRate'");
    expect(sql).toContain('"conversionValue" = NULL');
    expect(sql).not.toMatch(/UPDATE\s+"AdvertisingDailyMetric"\s+SET\s+"conversionValue"\s*=\s*NULL\s*;/i);
  });

  it('does not advertise normalized TikTok creative analytics as available', () => {
    const creative = BUSINESS_KNOWLEDGE_CATALOG.find((entry) => entry.domain === 'CREATIVES');
    expect(creative).toBeDefined();
    expect(creative?.sourceOfTruth).toContain('Meta creative/insight data');
    expect(creative?.sourceOfTruth.some((source) => /TikTok creative\/insight/i.test(source))).toBe(false);
    expect(creative?.caveats.join(' ')).toMatch(/TikTok normalized creative analytics are not available/i);
  });
});
