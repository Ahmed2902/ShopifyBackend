export const ORDER_HISTORY_BULK_QUERY = `#graphql
  {
    orders(sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          processedAt
          updatedAt
          cancelledAt
          cancelReason
          sourceName
          test
          currencyCode
          presentmentCurrencyCode
          displayFinancialStatus
          displayFulfillmentStatus
          currentSubtotalLineItemsQuantity
          currentSubtotalPriceSet { ...MoneyBagFields }
          currentShippingPriceSet { ...MoneyBagFields }
          currentTotalDiscountsSet { ...MoneyBagFields }
          currentTotalTaxSet { ...MoneyBagFields }
          currentTotalPriceSet { ...MoneyBagFields }
          discountCodes

          refunds {
            id
            createdAt
            processedAt
            updatedAt
            totalRefundedSet { ...MoneyBagFields }
          }

          lineItems {
            edges {
              node {
                id
                sku
                title
                variantTitle
                quantity
                currentQuantity
                refundableQuantity
                requiresShipping
                restockable
                product { id }
                variant { id }
                originalUnitPriceSet { ...MoneyBagFields }
                originalTotalSet { ...MoneyBagFields }
                discountedTotalSet(withCodeDiscounts: true) { ...MoneyBagFields }
                discountedUnitPriceAfterAllDiscountsSet { ...MoneyBagFields }
                totalDiscountSet { ...MoneyBagFields }
                discountAllocations {
                  allocatedAmountSet { ...MoneyBagFields }
                }
              }
            }
          }
        }
      }
    }
  }

  fragment MoneyBagFields on MoneyBag {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
`;

export const UPDATED_ORDERS_QUERY = `#graphql
  query UpdatedOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDER_DETAILS_QUERY = `#graphql
  query WebhookOrder($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      id
      name
      createdAt
      processedAt
      updatedAt
      cancelledAt
      cancelReason
      sourceName
      test
      currencyCode
      presentmentCurrencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      currentSubtotalLineItemsQuantity
      currentSubtotalPriceSet { ...MoneyBagFields }
      currentShippingPriceSet { ...MoneyBagFields }
      currentTotalDiscountsSet { ...MoneyBagFields }
      currentTotalTaxSet { ...MoneyBagFields }
      currentTotalPriceSet { ...MoneyBagFields }
      discountCodes
      refunds {
        id
        createdAt
        processedAt
        updatedAt
        totalRefundedSet { ...MoneyBagFields }
      }
      lineItems(first: $first, after: $after) {
        nodes {
          id
          sku
          title
          variantTitle
          quantity
          currentQuantity
          refundableQuantity
          requiresShipping
          restockable
          product { id }
          variant { id }
          originalUnitPriceSet { ...MoneyBagFields }
          originalTotalSet { ...MoneyBagFields }
          discountedTotalSet(withCodeDiscounts: true) { ...MoneyBagFields }
          discountedUnitPriceAfterAllDiscountsSet { ...MoneyBagFields }
          totalDiscountSet { ...MoneyBagFields }
          discountAllocations { allocatedAmountSet { ...MoneyBagFields } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }

  fragment MoneyBagFields on MoneyBag {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
`;

// Shopify Bulk Operations cannot place a connection under Order.refunds because
// refunds is a list rather than a connection. Refund headers therefore come
// from the bulk file and this focused query loads their line items afterward.
export const REFUND_DETAILS_QUERY = `#graphql
  query RefundDetails($refundId: ID!, $first: Int!, $after: String) {
    refund(id: $refundId) {
      id
      createdAt
      processedAt
      updatedAt
      totalRefundedSet { ...MoneyBagFields }
      refundLineItems(first: $first, after: $after) {
        nodes {
          id
          quantity
          restocked
          restockType
          lineItem { id }
          location { id }
          priceSet { ...MoneyBagFields }
          subtotalSet { ...MoneyBagFields }
          totalTaxSet { ...MoneyBagFields }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }

  fragment MoneyBagFields on MoneyBag {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
`;
