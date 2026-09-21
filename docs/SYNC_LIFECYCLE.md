# Shopify manual sync lifecycle

The manual Shopify sync endpoint is asynchronous. HTTP 202 means the sync request was accepted, not that synchronization has completed.

Frontend clients must treat the lifecycle as:

1. ACCEPTED / QUEUED
2. RUNNING
3. SUCCEEDED or FAILED

The UI must not update the merchant-facing `last successful sync` timestamp when the enqueue request returns. It should poll the corresponding sync run until a terminal state is observed, then refresh the workspace read models.

This document accompanies the sync-status implementation in this branch.
