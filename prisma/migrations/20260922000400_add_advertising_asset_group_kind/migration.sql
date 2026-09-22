-- Google Performance Max asset groups are part of Stride's shared canonical delivery-group hierarchy.
-- This migration is additive and idempotent for environments that may already have exercised the
-- earlier canonical advertising migration during QA.
ALTER TYPE "AdvertisingGroupKind" ADD VALUE IF NOT EXISTS 'ASSET_GROUP';
