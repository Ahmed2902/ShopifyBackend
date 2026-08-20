export const SHOP_QUERY = `#graphql
  query AppInstallationShop {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      primaryDomain { host url }
      enabledPresentmentCurrencies
      createdAt
    }
  }
`;

export const PRODUCTS_QUERY = `#graphql
  query CatalogProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
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
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `#graphql
  query CatalogVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
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
`;

export const LOCATIONS_QUERY = `#graphql
  query InventoryLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: true, includeLegacy: true) {
      nodes {
        id
        name
        isActive
        fulfillsOnlineOrders
        shipsInventory
        hasActiveInventory
        deactivatedAt
        address {
          address1
          address2
          city
          country
          countryCode
          province
          provinceCode
          zip
          phone
        }
        createdAt
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LOCATION_INVENTORY_QUERY = `#graphql
  query LocationInventory($locationId: ID!, $first: Int!, $after: String) {
    location(id: $locationId) {
      inventoryLevels(first: $first, after: $after, includeInactive: true) {
        nodes {
          id
          updatedAt
          item { id }
          location { id }
          quantities(names: [
            "available"
            "incoming"
            "committed"
            "damaged"
            "on_hand"
            "quality_control"
            "reserved"
            "safety_stock"
          ]) { name quantity }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
