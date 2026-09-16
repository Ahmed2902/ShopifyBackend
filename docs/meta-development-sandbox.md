# Meta development sandbox bootstrap

When `NODE_ENV=development`, Meta OAuth remains a real connection flow, but Meta Ads data is isolated from merchant assets.

After OAuth completes, the backend automatically:

1. Uses `META_SANDBOX_ACCESS_TOKEN` and `META_SANDBOX_AD_ACCOUNT_ID`.
2. Fetches that known sandbox account directly instead of calling `/me/adaccounts`.
3. Persists the sandbox account as the selected local account.
4. Syncs the sandbox ad hierarchy.
5. Syncs insights so the intelligence layer has data immediately.

Production keeps merchant account discovery and explicit asset configuration unchanged.
