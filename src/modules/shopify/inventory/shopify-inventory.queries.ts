export const LOCATION_BY_ID_QUERY = `#graphql
  query WebhookLocation($id: ID!) {
    location(id: $id) {
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
  }
`;

export const INVENTORY_LEVEL_BY_ITEM_LOCATION_QUERY = `#graphql
  query WebhookInventoryLevel($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId, includeInactive: true) {
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
    }
  }
`;
