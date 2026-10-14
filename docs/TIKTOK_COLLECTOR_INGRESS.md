# TikTok collector network context

Live diagnostics on 14 October showed 21 TikTok funnel attempts with a user
agent but no shopper IP, click identifier or browser identifier. They failed
with `MISSING_MATCH_IDENTIFIER`. The checkout test succeeds with a synthetic
test-only matching identifier and does not validate real shopper matching.
The signal-health identifier cards currently summarize purchases, so their
0/0 totals do not describe those funnel attempts.

The exact production forwarding headers were not available for inspection.
This change handles the documented Azure Container Apps ingress contract
instead of depending on Express recognizing every internal proxy hop.

`PIXEL_COLLECTOR_PROXY_MODE=azure-container-apps` makes the collector read only
the rightmost `X-Forwarded-For` address. Azure appends that value; preceding
values can be supplied by clients and are never selected. Invalid, private or
special-purpose addresses are omitted, with no fallback to earlier header
values or the container socket. See Microsoft's ingress documentation:
https://learn.microsoft.com/azure/container-apps/ingress-overview

The Azure deployment script sets this mode for the backend after checking its
public HTTP ingress. Other deployments default to `express`. Enable the Azure
mode only when collector requests traverse ACA HTTP ingress and the container
port cannot be reached directly by untrusted clients. A proxy in front of ACA
may make the rightmost address the proxy's address; configure a separately
validated trust chain before treating that topology as shopper evidence.
This mode applies only to conversion collector context; authentication and
rate-limit proxy settings retain their existing behavior.

After merge and Azure deployment, perform a fresh consented store journey
using the existing TikTok routing test: view a product, add it to cart and
begin checkout. Wait for dispatch, then inspect the new delivery coverage for
`ip: true` and `userAgent: true`, followed by a delivered receipt. Old dead
attempts are not revived. If fresh attempts still lack IP, inspect ingress
topology and request arrival age; IP capture is limited to events received
within five minutes. No Shopify pixel republish is needed for this change.
Do not fabricate a click ID or customer identifier. This validates transport
and event acceptance, not real ad attribution or customer matching.
