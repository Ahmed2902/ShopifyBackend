# Vercel Prisma runtime note

Stride uses Prisma's `prisma-client` generator with a custom output directory at `src/generated/prisma`.
That directory is intentionally git-ignored, so every deployment environment must generate the client before the Vercel Node function is traced and packaged.

`package.json` therefore runs `prisma generate` during `postinstall`. Keep the normal `build`-time generation as well so local and CI builds remain self-contained after schema changes.

A Vercel deployment can report `Ready` even if a function later crashes during invocation because a generated runtime dependency was not included in the function bundle. The production smoke checks are:

- `GET /health/live` => `{ "status": "ok" }`
- `GET /health/ready` => `{ "status": "ready" }`

The second endpoint also verifies PostgreSQL connectivity.
