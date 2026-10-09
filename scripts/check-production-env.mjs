// Uses the same built startup validation without opening a database connection.
try {
  const { env } = await import('../dist/config/env.js');
  const placeholders = Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && /^REPLACE_WITH_|^<[^>]+>$/.test(value))
    .map(([key]) => key);
  if (placeholders.length) {
    console.error(`Unfilled production settings: ${placeholders.join(', ')}`);
    process.exit(1);
  }
  if (env.NODE_ENV !== 'production') throw new Error('Production environment required');
  // This module validates the actual 32-byte token-encryption key at import time.
  await import('../dist/modules/integrations/integration.utils.js');
  console.log(
    'Production startup configuration is valid. No network or account approvals were checked.',
  );
} catch (error) {
  // Report setting names only; never echo configuration values or stack traces.
  const keys = Array.isArray(error?.issues)
    ? [
        ...new Set(
          error.issues
            .map((issue) => issue.path?.[0])
            .filter((key) => typeof key === 'string' && /^[A-Z_]+$/.test(key)),
        ),
      ]
    : [];
  console.error(
    `Production configuration rejected${keys.length ? `: ${keys.join(', ')}` : ''}. Check backend.env, Shopify pricing configuration and the encryption key.`,
  );
  process.exit(1);
}
