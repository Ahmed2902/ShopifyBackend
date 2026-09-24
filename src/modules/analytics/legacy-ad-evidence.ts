export interface LegacyAdvertisingPeriodMetric {
  sourceRows: number;
  spend: number;
}

export interface LegacyAdvertisingCurrencyBucket {
  currency: string;
  current: LegacyAdvertisingPeriodMetric;
  comparison: LegacyAdvertisingPeriodMetric;
}

export interface LegacyAdvertisingPeriodEvidence {
  evidenceAvailable: boolean;
  /**
   * Kept numeric for the legacy response contract. Consumers must use evidenceAvailable before
   * interpreting this as provider-reported fact; a missing period intentionally carries 0 only as
   * a compatibility placeholder.
   */
  spend: number;
}

export function resolveLegacyAdvertisingEvidence(
  currencies: LegacyAdvertisingCurrencyBucket[],
  storeCurrency: string,
): {
  current: LegacyAdvertisingPeriodEvidence;
  comparison: LegacyAdvertisingPeriodEvidence;
} {
  const bucket = currencies.find((item) => item.currency === storeCurrency);
  return {
    current: {
      evidenceAvailable: (bucket?.current.sourceRows ?? 0) > 0,
      spend: bucket?.current.spend ?? 0,
    },
    comparison: {
      evidenceAvailable: (bucket?.comparison.sourceRows ?? 0) > 0,
      spend: bucket?.comparison.spend ?? 0,
    },
  };
}

export function legacyMer(
  netOrderValue: number,
  period: LegacyAdvertisingPeriodEvidence,
): number | null {
  if (!period.evidenceAvailable || period.spend <= 0) return null;
  return netOrderValue / period.spend;
}

export function legacyContributionAfterAds(
  contributionBeforeAds: number | null,
  period: LegacyAdvertisingPeriodEvidence,
): number | null {
  if (!period.evidenceAvailable || contributionBeforeAds === null) return null;
  return contributionBeforeAds - period.spend;
}

export function legacySpendChange(
  current: LegacyAdvertisingPeriodEvidence,
  comparison: LegacyAdvertisingPeriodEvidence,
): number | null {
  if (!current.evidenceAvailable || !comparison.evidenceAvailable) return null;
  if (comparison.spend === 0) return current.spend === 0 ? 0 : null;
  return (current.spend - comparison.spend) / Math.abs(comparison.spend);
}
