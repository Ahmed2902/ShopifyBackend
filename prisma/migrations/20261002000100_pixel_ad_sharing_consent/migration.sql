-- Historical analytics consent must not authorize advertising disclosure.
ALTER TABLE "StorefrontEvent" ADD COLUMN "adSharingAllowed" BOOLEAN NOT NULL DEFAULT false;
