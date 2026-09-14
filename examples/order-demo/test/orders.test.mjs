import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { filterOrders, processOrders } from '../src/orders.mjs'

const policy = JSON.parse(await readFile(new URL('../config/order-policy.json', import.meta.url), 'utf8'))

test('minimum amount is inclusive and invalid amounts are excluded', () => {
  assert.deepEqual(filterOrders([{ id: 'small', amount: 9 }, { id: 'limit', amount: 10 }, { id: 'invalid', amount: NaN }], policy), [{ id: 'limit', amount: 10 }])
})

test('accepted orders become queue results without mutating input', () => {
  const orders = [{ id: 'demo-1', amount: 12 }]
  assert.deepEqual(processOrders(orders, policy), [{ id: 'demo-1', status: 'queued' }])
  assert.deepEqual(orders, [{ id: 'demo-1', amount: 12 }])
})
