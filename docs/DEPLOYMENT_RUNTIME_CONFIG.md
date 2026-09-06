# Deployment runtime configuration

Stride's core API must be able to boot when optional integrations are not configured yet.

## Required at boot

Core infrastructure and currently-required providers remain validated at startup (database, Redis, JWT/token encryption, Shopify, Meta, etc.).

## Authentication URLs

`EMAIL_VERIFICATION_URL` and `PASSWORD_RESET_URL` are optional overrides. When omitted they are derived from `CORS_ORIGIN`:

- `/auth/verify-email`
- `/auth/reset-password`

This keeps production auth links aligned with the canonical frontend origin.

## TikTok

TikTok credentials are optional until the TikTok integration is actually used. Missing TikTok credentials must not prevent Shopify, Meta, auth, health checks, or pixel ingestion from booting.

TikTok entry points return `TIKTOK_NOT_CONFIGURED` when the provider has not been configured.
