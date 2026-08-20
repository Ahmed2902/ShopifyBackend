export const WEBHOOK_SUBSCRIPTIONS_QUERY = `#graphql
  query ManagedWebhookSubscriptions($first: Int!, $after: String) {
    webhookSubscriptions(first: $first, after: $after) {
      nodes {
        id
        topic
        uri
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `#graphql
  mutation CreateWebhookSubscription(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION = `#graphql
  mutation UpdateWebhookSubscription(
    $id: ID!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;
