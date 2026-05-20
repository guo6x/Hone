/**
 * Broker adapter slot.
 *
 * Reality of A-share retail: most brokers do NOT expose trading APIs to individuals.
 * Workable plugin paths the user can implement and register here:
 *
 *   - easytrader (open source, drives 通达信 client via UI automation, may trigger broker risk control)
 *   - 富途 / 老虎 OpenAPI (HK/US stocks, requires API token from your account)
 *   - 自家券商 if you have institutional API access
 *
 * Default behavior when NO adapter is registered for an item:
 *   signal → mobile push notification → wait for user manual action.
 *
 * To add an adapter at runtime, call `registerBrokerAdapter('easytrader', adapter)`
 * from any module loaded by the daemon (e.g. import a side-effect module on start).
 */

export interface BrokerOrder {
  symbol: string         // e.g. '600519'
  side: 'buy' | 'sell'
  quantity: number       // shares (A股 must be multiples of 100)
  price?: number         // null = market order; otherwise limit price
  reason?: string        // human-readable why-the-agent-recommends-this
}

export interface BrokerOrderResult {
  ok: boolean
  order_id?: string
  filled_qty?: number
  filled_price?: number
  error?: string
  raw?: unknown
}

export interface BrokerPosition {
  symbol: string
  quantity: number
  avg_cost: number
  market_value?: number
  pnl?: number
}

export interface BrokerAdapter {
  name: string
  /** Connect / authenticate. Called once on register. */
  connect?: () => Promise<void>
  /** Place an order (buy or sell). */
  placeOrder: (order: BrokerOrder) => Promise<BrokerOrderResult>
  /** Optional: pull current positions for reconciliation. */
  listPositions?: () => Promise<BrokerPosition[]>
  /** Optional: cancel an outstanding order. */
  cancelOrder?: (orderId: string) => Promise<boolean>
}

const adapters = new Map<string, BrokerAdapter>()

export function registerBrokerAdapter(adapter: BrokerAdapter): void {
  adapters.set(adapter.name, adapter)
  console.error(`[Broker] Registered adapter: ${adapter.name}`)
}

export function getBrokerAdapter(name: string): BrokerAdapter | null {
  return adapters.get(name) || null
}

export function listBrokerAdapters(): string[] {
  return Array.from(adapters.keys())
}

/**
 * Try to execute via a registered adapter. Returns null if no adapter or not authorized,
 * else the result. Caller falls back to notification when null.
 */
export async function tryAutoExecute(
  brokerName: string | undefined,
  order: BrokerOrder,
): Promise<BrokerOrderResult | null> {
  if (!brokerName) return null
  const adapter = getBrokerAdapter(brokerName)
  if (!adapter) {
    console.error(`[Broker] No adapter registered for "${brokerName}" — falling back to notification`)
    return null
  }
  try {
    return await adapter.placeOrder(order)
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
