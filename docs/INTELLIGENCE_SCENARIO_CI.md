# Intelligence scenario PR validation

The intelligence scenario harness is validated by the normal pull-request CI before merge.

The PR verification run must complete all existing backend checks, including:

- production TypeScript build;
- Prisma migration deploy and drift verification against PostgreSQL;
- Prisma validation;
- ESLint;
- TypeScript typecheck;
- the full Vitest suite, including the intelligence scenario matrix and service-level snapshot scenarios;
- production Docker image build.

The implementation commits on this branch intentionally use CI/deployment skip markers so quota is not consumed while the harness is still being edited. This final verification commit intentionally does not contain a skip marker, allowing one complete PR validation run on the finished branch state.

A green synthetic scenario harness proves deterministic rule semantics and data-quality behavior. It does not replace the final end-to-end validation with a consenting merchant account that has real historical Meta delivery and Shopify commerce data.
