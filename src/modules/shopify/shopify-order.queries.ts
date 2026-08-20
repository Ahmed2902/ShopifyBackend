export const ORDERS_QUERY = `#graphql
  query OrderHistory($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT) {
      nodes {
        id
        name
        createdAt
        processedAt
        updatedAt
        cancelledAt
        cancelReason
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

        lineItems(first: 50) {
          nodes { ...OrderLineItemFields }
          pageInfo { hasNextPage endCursor }
        }

        refunds(first: 250) {
          id
          createdAt
          processedAt
          updatedAt
          totalRefundedSet { ...MoneyBagFields }
          refundLineItems(first: 50) {
            nodes { ...RefundLineItemFields }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }

  fragment MoneyBagFields on MoneyBag {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }

  fragment OrderLineItemFields on LineItem {
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

  fragment RefundLineItemFields on RefundLineItem {
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
`;

export const ORDER_LINE_ITEMS_QUERY = `#graphql
  query OrderLineItems($orderId: ID!, $first: Int!, $after: String) {
    order(id: $orderId) {
      lineItems(first: $first, after: $after) {
        nodes { ...OrderLineItemFields }
        pageInfo { hasNextPage endCursor }
      }
    }
  }

  fragment MoneyBagFields on MoneyBag {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }

  fragment OrderLineItemFields on LineItem {
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
`;

export const REFUND_LINE_ITEMS_QUERY = `#graphql
  query RefundLineItems($refundId: ID!, $first: Int!, $after: String) {
    refund(id: $refundId) {
      refundLineItems(first: $first, after: $after) {
        nodes { ...RefundLineItemFields }
        pageInfo { hasNextPage endCursor }
      }
    }
  }

  fragment MoneyBagFields on MoneyBag {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }

  fragment RefundLineItemFields on RefundLineItem {
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
`;
