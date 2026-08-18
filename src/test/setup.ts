process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/shopify_intelligence_test';
process.env.CORS_ORIGIN ??= 'http://localhost:3000';
process.env.LOG_LEVEL ??= 'silent';
