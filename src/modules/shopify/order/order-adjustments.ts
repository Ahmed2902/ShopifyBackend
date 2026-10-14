// Shopify current totals already include returns; never subtract the same refund again.
// Product totals include removed/refunded units. Reconcile quantity and money together.
export function lineAdjustment(input: { quantity: number; currentQuantity: number;
  productRevenue: number; refundedUnits: number; refundedValue: number }) {
  const removed = Math.max(0, input.quantity - input.currentQuantity);
  const units = Math.min(input.quantity, Math.max(removed, input.refundedUnits));
  const quantityValue = input.quantity > 0 ? input.productRevenue * removed / input.quantity : 0;
  return { units, value: Math.min(input.productRevenue, Math.max(quantityValue, input.refundedValue)) };
}
