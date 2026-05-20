/**
 * Pattern-based intent recognition for stock tracking.
 *
 * Sits BEFORE the LLM in the message pipeline: if the user types something
 * obviously about stocks ("盯着 600519", "我买了 1000 股 @1500", "卖了 茅台"),
 * we handle it deterministically — no LLM tokens, no misinterpretation.
 *
 * Returns null when nothing matches; gateway then falls back to LLM.
 */
import {
  upsertTrackedItem, getTrackedItemByIdentifier, closeTrackedItem,
  listTrackedItems, recordObservation, recordRecommendation,
  getRecommendations, reviewRecommendation,
  type TrackedItem,
} from '../storage.js'
import { fetchStockQuote, fetchStockQuotes, type StockQuote } from '../datasources/stock-cn.js'

export interface StockIntentResult {
  reply: string
  items_changed?: TrackedItem[]
  needs_monitor?: TrackedItem[]  // hint to caller to wire up schedules
}

const CODE = String.raw`(?:sh|sz)?(\d{6})`
// Match symbol code OR a chinese name in parens like "600519茅台" or "茅台(600519)"
const CODE_OR_NAMED = new RegExp(CODE, 'i')

function normalize(code: string): string {
  return code.replace(/^(sh|sz)/i, '').padStart(6, '0')
}

function fmtQuote(q: StockQuote): string {
  const sign = q.change >= 0 ? '+' : ''
  return `${q.name}(${q.symbol}) ${q.current.toFixed(2)} ${sign}${q.change.toFixed(2)} (${sign}${q.change_pct.toFixed(2)}%)`
}

/**
 * Detect intent. Returns null if not stock-related — caller falls through to LLM.
 */
export async function tryStockIntent(text: string): Promise<StockIntentResult | null> {
  const t = text.trim()

  // 1. WATCH: "盯/关注/盯盘/跟踪 600519" (no quantity = just watching)
  const watchMatch = t.match(new RegExp(`^(?:帮我)?(?:盯[着住]?|关注|跟踪|监控)\\s*(?:股票|股|A股)?\\s*${CODE}(?:\\s*(.+))?$`, 'i'))
  if (watchMatch) {
    const code = normalize(watchMatch[1])
    const userLabel = watchMatch[2]?.trim()
    const quote = await fetchStockQuote(code).catch(() => null)
    if (!quote) return { reply: `没拿到 ${code} 的行情，可能代码不对或网络问题。` }
    const id = upsertTrackedItem({
      kind: 'stock',
      identifier: code,
      display_name: userLabel || quote.name,
      status: 'watching',
    })
    recordObservation({
      item_id: id,
      data: quote,
      agent_assessment: `开始盯盘`,
    })
    const item = getTrackedItemByIdentifier('stock', code)!
    return {
      reply: `已开始盯 ${fmtQuote(quote)}\n之后会自动监控，有信号会主动告诉你。`,
      items_changed: [item],
      needs_monitor: [item],
    }
  }

  // 2. BUY: "我买了 1000 股 600519 @1500" / "买入 600519 1000股 1500"
  const buyMatch = t.match(new RegExp(`(?:我)?(?:买[了入入])\\s*(?:了)?\\s*(\\d+)\\s*股?\\s*(?:.*?)${CODE}(?:.*?)(?:@|价|价格|股价|每股)?\\s*(\\d+(?:\\.\\d+)?)`, 'i'))
  if (buyMatch) {
    const shares = Number(buyMatch[1])
    const code = normalize(buyMatch[2])
    const avgCost = Number(buyMatch[3])
    const quote = await fetchStockQuote(code).catch(() => null)
    const existing = getTrackedItemByIdentifier('stock', code)
    // If already a position, average in
    let newShares = shares, newCost = avgCost
    if (existing?.user_position) {
      const p = existing.user_position as any
      if (p.shares) {
        const totalShares = p.shares + shares
        newCost = ((p.shares * p.avg_cost) + (shares * avgCost)) / totalShares
        newShares = totalShares
      }
    }
    const id = upsertTrackedItem({
      kind: 'stock',
      identifier: code,
      display_name: quote?.name || existing?.display_name,
      user_position: {
        shares: newShares,
        avg_cost: Number(newCost.toFixed(3)),
        broker_authorized: (existing?.user_position as any)?.broker_authorized || false,
      },
      status: 'committed',
    })
    if (quote) {
      recordObservation({
        item_id: id,
        data: { ...quote, user_action: `bought ${shares} @ ${avgCost}` },
        agent_assessment: `用户买入 ${shares} 股 @ ${avgCost}，当前价 ${quote.current}`,
      })
    }
    const item = getTrackedItemByIdentifier('stock', code)!
    const pnl = quote ? ((quote.current - newCost) / newCost) * 100 : null
    return {
      reply: `记下了：${quote?.name || code} 持仓 ${newShares} 股，均价 ${newCost.toFixed(2)}` +
        (pnl !== null ? `（现价 ${quote!.current}，浮${pnl >= 0 ? '盈' : '亏'} ${pnl.toFixed(2)}%）` : '') +
        `\n我会继续监控，有动向告诉你。`,
      items_changed: [item],
      needs_monitor: [item],
    }
  }

  // 3. SELL: "卖了 600519" / "卖出 茅台 @1600"
  const sellMatch = t.match(new RegExp(`(?:我)?(?:卖[了出])\\s*(?:了)?\\s*(?:.*?)${CODE}(?:.*?)(?:@|价|价格)?\\s*(\\d+(?:\\.\\d+)?)?`, 'i'))
  if (sellMatch) {
    const code = normalize(sellMatch[1])
    const sellPrice = sellMatch[2] ? Number(sellMatch[2]) : null
    const existing = getTrackedItemByIdentifier('stock', code)
    if (!existing) {
      return { reply: `${code} 不在追踪列表里，没法记复盘。` }
    }
    const p = existing.user_position as any || {}
    const quote = sellPrice ? null : await fetchStockQuote(code).catch(() => null)
    const exit = sellPrice ?? quote?.current
    let pnlNote = ''
    if (p.shares && p.avg_cost && exit) {
      const pnl = (exit - p.avg_cost) * p.shares
      const pct = ((exit - p.avg_cost) / p.avg_cost) * 100
      pnlNote = `\n实现盈亏: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`
      // Loop closure: any agent recommendations on this item that were never reviewed
      // get retroactively scored. Don't write a NEW recommendation record (that would
      // pollute the agent's accuracy stats with user-driven actions).
      const outcome = pct >= 0 ? 'good' : 'bad'
      const note = `平仓 @ ${exit}, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
      const pending = getRecommendations(existing.id, 100).filter(r => !r.outcome)
      for (const rec of pending) {
        reviewRecommendation(rec.id, outcome, note)
      }
    }
    closeTrackedItem(existing.id, `已平仓 @ ${exit ?? '未知价'}`)
    return {
      reply: `已记录平仓 ${existing.display_name || code} @ ${exit ?? '未知'}.${pnlNote}\n后续复盘时我会回顾这单决策。`,
      items_changed: [{ ...existing, status: 'closed', closed_at: Date.now() }],
    }
  }

  // 4. QUOTE: "现在 600519 / 看 茅台 / 查一下 600519"
  const quoteMatch = t.match(new RegExp(`^(?:现在|看一下|看看|查一下|查|盯一下|股价|行情)\\s*(?:.*?)${CODE}`, 'i'))
  if (quoteMatch) {
    const code = normalize(quoteMatch[1])
    const quote = await fetchStockQuote(code).catch(() => null)
    if (!quote) return { reply: `${code} 拿不到数据。` }
    const existing = getTrackedItemByIdentifier('stock', code)
    if (existing) {
      recordObservation({ item_id: existing.id, data: quote })
    }
    let posNote = ''
    if (existing?.user_position) {
      const p = existing.user_position as any
      if (p.shares && p.avg_cost) {
        const pct = ((quote.current - p.avg_cost) / p.avg_cost) * 100
        posNote = `\n你持仓: ${p.shares} 股 @ ${p.avg_cost}，浮${pct >= 0 ? '盈' : '亏'} ${pct.toFixed(2)}%`
      }
    }
    return { reply: `${fmtQuote(quote)}${posNote}` }
  }

  // 5. LIST: "盯盘列表 / 我的持仓 / 持仓 / 我盯了哪些"
  if (/^(?:盯盘列表|我的持仓|持仓|我盯了哪些|盯了什么|持仓列表)$/.test(t)) {
    const watching = listTrackedItems({ kind: 'stock', status: 'watching' })
    const committed = listTrackedItems({ kind: 'stock', status: 'committed' })
    const all = [...committed, ...watching]
    if (all.length === 0) return { reply: '还没盯任何股票。' }
    const codes = all.map(i => i.identifier)
    const quotes = await fetchStockQuotes(codes).catch(() => [])
    const quoteMap = new Map(quotes.map(q => [q.symbol, q]))
    const lines = all.map(item => {
      const q = quoteMap.get(item.identifier)
      const p = item.user_position as any
      const status = item.status === 'committed' ? '持仓' : '关注'
      if (q && p?.shares && p?.avg_cost) {
        const pct = ((q.current - p.avg_cost) / p.avg_cost) * 100
        const sign = pct >= 0 ? '+' : ''
        return `[${status}] ${q.name}(${q.symbol}) ${q.current.toFixed(2)} · ${p.shares}股@${p.avg_cost} · ${sign}${pct.toFixed(2)}%`
      }
      return q
        ? `[${status}] ${q.name}(${q.symbol}) ${q.current.toFixed(2)} (${q.change_pct.toFixed(2)}%)`
        : `[${status}] ${item.display_name || item.identifier}（拿不到行情）`
    })
    return { reply: lines.join('\n') }
  }

  return null
}
