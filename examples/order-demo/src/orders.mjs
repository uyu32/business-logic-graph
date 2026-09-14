// Fictional example: no network, customer data, or real queue.
export function filterOrders(orders, policy) {
  return orders.filter((order) => Number.isFinite(order.amount) && order.amount >= policy.minimumAmount)
}

export function processOrders(orders, policy) {
  return filterOrders(orders, policy).map((order) => ({ id: order.id, status: 'queued' }))
}
