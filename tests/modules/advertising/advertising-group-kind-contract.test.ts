import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('prisma/models/advertising.prisma', 'utf8');
const assetGroupMigration = readFileSync(
  'prisma/migrations/20260922000400_add_advertising_asset_group_kind/migration.sql',
  'utf8',
);

describe('canonical advertising group-kind contract', () => {
  it('keeps AD_SET, AD_GROUP and ASSET_GROUP in the shared hierarchy', () => {
    const groupKind = schema.match(/enum AdvertisingGroupKind \{([\s\S]*?)\}/)?.[1] ?? '';

    expect(groupKind).toContain('AD_SET');
    expect(groupKind).toContain('AD_GROUP');
    expect(groupKind).toContain('ASSET_GROUP');
    expect(assetGroupMigration).toContain(
      `ALTER TYPE "AdvertisingGroupKind" ADD VALUE IF NOT EXISTS 'ASSET_GROUP'`,
    );
  });
});
