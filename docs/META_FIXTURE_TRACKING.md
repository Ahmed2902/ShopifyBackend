# Meta fixture tracking coverage

The connected-account Meta fixture writer seeds analytics and hierarchy rows in Stride's local database. It does not call Meta write APIs.

After `npm run dev:meta-fixtures:write` finishes the normal hierarchy/insights seed, Stride now applies a fixture-only tracking coverage pass to the generated `stride_fixture_` creatives. Existing UTM parameters are preserved while the fixture rows are deliberately distributed across three audit states:

- `EXACT`: all Stride campaign, ad-set, and ad ID parameters are present.
- `PARTIAL`: only part of the Stride tracking template is present.
- `MISSING`: merchant UTM parameters remain, but no Stride tracking IDs are present.

The pass also creates a mix of automatic-supported and manual-required fixture creative shapes so the frontend workflow can exercise both paths. These shapes exist only on local fixture rows; they are not provider mutations.

Preview the target and resulting coverage without changing data:

```bash
META_FIXTURE_STORE_ID=<store-uuid> \
META_FIXTURE_AD_ACCOUNT_ID=act_123456789 \
META_FIXTURE_CONFIRM_AD_ACCOUNT_ID=act_123456789 \
npm run dev:meta-fixtures:tracking
```

The normal write command runs the tracking pass automatically:

```bash
npm run dev:meta-fixtures:write
```

Safety rules remain the same as the base fixture writer: production is rejected, the exact selected store/account must exist, the confirmation account ID must match, and only `stride_fixture_` creatives are modified.
