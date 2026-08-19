process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/shopify_intelligence_test';
process.env.CORS_ORIGIN ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'silent';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-longer-than-thirty-two-characters';
process.env.JWT_ISSUER ??= 'shopify-intelligence-api-test';
process.env.ACCESS_TOKEN_TTL_SECONDS ??= '900';
process.env.REFRESH_TOKEN_TTL_DAYS ??= '30';
