import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service = readFileSync(
  'src/modules/tiktok/insights/tiktok-insights.service.ts',
  'utf8',
);
const repository = readFileSync(
  'src/modules/tiktok/insights/tiktok-insights.repository.ts',
  'utf8',
);

describe('TikTok insights ingestion contract', () => {
  it('bulk-resolves ads and uses bounded native + canonical write batches', () => {
    expect(service).toContain('tiktokAdId: { in: externalAdIds }');
    expect(service).toContain('INSIGHT_WRITE_BATCH_SIZE = 100');
    expect(service).toContain('this.repository.upsertInsights(batch)');
    expect(service).not.toContain('this.adsRepository.getAd(');
    expect(service).not.toContain('this.repository.upsertInsight({');
    expect(repository).toContain('upsertInsights(inputs: Prisma.TikTokInsightDailyUncheckedCreateInput[])');
    expect(repository).toContain('return prisma.$transaction(async (tx) => {');
  });

  it('does not treat TikTok complete-payment rate as monetary conversion value', () => {
    expect(service).toContain('conversionValue: null');
    expect(service).toContain("'total_complete_payment_rate'");
    expect(repository).toContain('metrics: native.metricsJson');
  });
});
