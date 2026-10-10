# Enable automatic Azure deployment once, through the UI

The workflow is ready but deliberately disabled until `AZURE_AUTO_DEPLOY_ENABLED=true` is configured in each repository. After setup, merging a release into `main` runs CI, publishes the image and deploys that exact image digest to the existing Azure Container App. Backend startup applies pending migrations before the API and workers start. No manual image edits, Azure migration job or additional hosting service is needed.

This document applies to `Ahmed2902/ShopifyBackend` and `Ahmed2902/metrico-frontend`. Use the frontend repository's current name, not `ShopifyFrontend`.

## 1. Finish the first deployment

Create both existing Container Apps, enter their runtime settings and private GHCR registry credentials, and verify they run. Follow [the Azure deployment walkthrough](https://github.com/Ahmed2902/ShopifyBackend/blob/main/docs/AZURE_PORTAL_DEPLOYMENT.md) first. Automation updates existing apps; it does not create resources or enter application secrets.

Before enabling automation, verify:

| Setting                         | Backend                                                              | Frontend                             |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Revision mode                   | Single                                                               | Single                               |
| Target port                     | 3001                                                                 | 3000                                 |
| Public HTTP ingress             | Enabled                                                              | Enabled                              |
| Command and arguments overrides | Empty                                                                | Empty                                |
| HTTP readiness probe            | `/health/ready`, port 3001                                           | `/api/health`, port 3000             |
| Backend startup probe           | `/health/live`, port 3001, interval 10 seconds, failure threshold 60 | Not required by deployment preflight |
| Minimum / maximum replicas      | 1 / 1                                                                | Your existing frontend limits        |
| Private registry                | `ghcr.io`, existing username and PAT secret reference                | Same                                 |

For readiness use interval 30 seconds, timeout 5 seconds, failure threshold 3. Configure probes under **Containers → Edit and deploy → Health probes**. Automation stops before updating an app if the required settings are missing. Keep actual application secrets in Azure. The private GHCR read token already configured in Azure still needs to remain valid; identity federation authenticates deployment to Azure, not image pulls from GitHub.

## 2. Create an Azure deployment identity

In **Azure portal → Microsoft Entra ID → App registrations → New registration**:

1. Name: `metrico-github-deploy`.
2. Supported account types: accounts in this organizational directory only (single tenant).
3. Leave Redirect URI empty and choose **Register**.
4. On **Overview**, copy **Application (client) ID** and **Directory (tenant) ID**.
5. In **Azure portal → Subscriptions → your subscription → Overview**, copy **Subscription ID**.

This identity is only for deployment; it does not replace Shopify, TikTok or Google OAuth credentials. No client secret or Azure password is needed.

## 3. Trust the two GitHub main branches

Open the new app registration → **Certificates & secrets → Federated credentials → Add credential**. Select **GitHub Actions deploying Azure resources**.

Create these two credentials:

| Field                | Backend credential     | Frontend credential     |
| -------------------- | ---------------------- | ----------------------- |
| Organization / owner | `Ahmed2902`            | `Ahmed2902`             |
| Repository           | `ShopifyBackend`       | `metrico-frontend`      |
| Entity type          | Branch                 | Branch                  |
| Branch               | `main`                 | `main`                  |
| Name                 | `metrico-backend-main` | `metrico-frontend-main` |

Azure should calculate these exact subjects:

```text
repo:Ahmed2902/ShopifyBackend:ref:refs/heads/main
repo:Ahmed2902/metrico-frontend:ref:refs/heads/main
```

Keep the GitHub issuer and Azure token-exchange audience supplied by the form. Do not choose Environment or Pull request: these workflows use branch federation, with no GitHub Environment required. Save both credentials. Treat owner/repository/branch spelling and case as exact.

## 4. Grant the identity access to Metrico's resource group

In **Resource groups → your Metrico production group → Access control (IAM) → Add → Add role assignment**:

1. Select **Container Apps Contributor**, then **Next**.
2. Assign access to **User, group, or service principal**.
3. Choose **Select members**, search `metrico-github-deploy`, select it and confirm.
4. Choose **Review + assign**.

Assign this role at the Metrico resource-group scope. No subscription-wide Owner assignment is needed. If `Add role assignment` is disabled, your Azure account needs role-assignment authority at that scope; do not substitute application API permissions. Allow several minutes for a new role assignment to propagate.

## 5. Add three GitHub secrets to both repositories

For each repository, open **Settings → Secrets and variables → Actions → Secrets → New repository secret**:

| Secret                  | Value                               |
| ----------------------- | ----------------------------------- |
| `AZURE_CLIENT_ID`       | Application (client) ID from step 2 |
| `AZURE_TENANT_ID`       | Directory (tenant) ID from step 2   |
| `AZURE_SUBSCRIPTION_ID` | Your Azure subscription ID          |

The same three values go in both repositories. Although these IDs are identifiers, the Azure login action reads them from repository secrets. Do not create `AZURE_CLIENT_SECRET` or upload application runtime secrets to GitHub for this deployment.

## 6. Add the deployment variables

In each repository's **Settings → Secrets and variables → Actions → Variables → New repository variable**, enter:

| Variable                    | Backend repository                                        | Frontend repository                                         |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `AZURE_RESOURCE_GROUP`      | Exact existing resource-group name                        | Same existing resource-group name                           |
| `AZURE_CONTAINER_APP`       | Exact backend Container App name (e.g. `metrico-backend`) | Exact frontend Container App name (e.g. `metrico-frontend`) |
| `AZURE_AUTO_DEPLOY_ENABLED` | `true`                                                    | `true`                                                      |

Use the actual names shown in Azure Overview. Set the enable variable last, after the identity, roles, credentials, apps and probes are ready. No GitHub Environment or per-release approval is required by these workflows; your normal manual PR merge remains the release trigger. Existing frontend public build variables, including `NEXT_PUBLIC_SENTRY_DSN`, stay in place.

## 7. Merge the prepared PRs and verify the first automatic release

Manually merge the backend and frontend deployment PRs after their latest-head CI passes. If you merge them before configuring Azure, their publication succeeds and the deployment job is skipped until the enable variable is true.

In **GitHub → Actions**, watch **CI** followed by **Publish containers**. That publication workflow now includes **Deploy backend to Azure** or **Deploy frontend to Azure**. It:

1. Verifies successful main-push CI for the exact release.
2. Skips an outdated release if `main` has advanced.
3. Logs in with GitHub's short-lived federated identity.
4. Validates the existing app's deployment settings.
5. Updates only the selected container image and its `SENTRY_RELEASE` setting.
6. Waits for the new revision, its exact image digest, Azure readiness and the HTTP health response.
7. Records the deployed image, new revision and preceding ready revision in the workflow summary.

Checks use the Azure-generated HTTPS hostname, so a custom-domain certificate delay does not block the deployment mechanism. Verify custom domains separately before clients use them.

If setup happened after merging, open **Actions → Publish containers → Run workflow**, choose **main** and run it once. This rebuilds/publishes the current release using the existing cache, then deploys it. Every later successful release does this automatically; you no longer paste hashes into Azure.

## 8. Failure handling and pausing

A failed CI or image publication cannot trigger deployment. A failed migration cannot start the new backend. The workflow reports failure if the new revision never becomes ready, even when an older revision answers health requests. Azure's Single revision mode controls the readiness-based traffic handover. No automatic application or database rollback is attempted; a migration may already have applied before an application failure.

Keep migrations compatible with the previous application release. For an incompatible/destructive database change, disable backend auto-deployment first and plan maintenance. To pause either service, set its repository variable `AZURE_AUTO_DEPLOY_ENABLED` to `false` before starting another release. A job already running must also be stopped in Actions; changing a variable does not cancel an in-flight deployment. Review the exact deployed/previous revisions under Azure **Revisions and replicas** before a manual rollback.

The automation adds no paid hosting resource. It uses the existing GitHub runners and Azure apps; the deploy job's wait counts toward Actions usage. Frontend and backend release independently, so cross-service changes must remain compatible during their separate rollouts. Live Azure authentication, role assignments and actual rollout can only be verified after completing the account setup above.

References: [Microsoft's GitHub federation setup](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust?pivots=identity-wif-app-reg-github-actions), [Azure login action](https://github.com/Azure/login), [Container Apps roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers#container-apps-contributor), [Azure Container Apps GitHub deployment](https://learn.microsoft.com/en-us/azure/container-apps/github-actions).
