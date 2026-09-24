# Canonical advertising read parity

This checkpoint validates the provider-neutral read boundary before production cutover.

The parity suite compares canonical Meta reads against the established provider-native behavior for:

- overview period/currency aggregation;
- campaign entity aggregation;
- ad-level Product × Ads aggregation;
- active product mappings;
- deterministic campaign and creative intelligence evidence.

Canonical reads consume normalized scalar facts from `AdvertisingDailyMetric`; provider-specific action parsing remains an ingestion concern.

Production read paths stay unchanged until this branch passes the complete backend quality gate.
