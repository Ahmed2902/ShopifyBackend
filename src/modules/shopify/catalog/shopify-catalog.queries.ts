export const PRODUCT_BY_ID_QUERY = `#graphql
  query WebhookProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      productType
      vendor
      tags
      status
      totalInventory
      tracksInventory
      publishedAt
      createdAt
      updatedAt
    }
  }
`;

export const PRODUCT_VARIANTS_BY_ID_QUERY = `#graphql
  query WebhookProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        nodes {
          id
          title
          displayName
          sku
          barcode
          price
          compareAtPrice
          position
          availableForSale
          inventoryQuantity
          inventoryPolicy
          createdAt
          updatedAt
          selectedOptions { name value }
          product { id }
          inventoryItem {
            id
            sku
            tracked
            requiresShipping
            createdAt
            updatedAt
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
