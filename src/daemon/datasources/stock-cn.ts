/**
 * A 股行情数据源 — free, no API key.
 *
 * Primary: 东方财富 push2 接口 (JSON, UTF-8)
 * Backup:  新浪 hq.sinajs.cn (GBK, 需要 Referer header)
 *
 * 用 symbol 例子: '600519' (上证), '000001' (深证), 'sh600519' / 'sz000001' (带前缀)
 */

export interface StockQuote {
  symbol: string
  name: string
  current: number
  prev_close: number
  open?: number
  high?: number
  low?: number
  change: number
  change_pct: number
  volume?: number
  amount?: number
  ts: number
}

/** fetch 包装：10 秒超时，防止行情 API 挂起阻塞调度器。 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 判断市场前缀：6/5/9 开头 = 上证 (sh)，8/4 开头 = 北交所 (bj)，其他 = 深证 (sz)。 */
function detectMarket(code: string): 'sh' | 'sz' | 'bj' {
  const clean = code.replace(/^(sh|sz|bj)/i, '')
  if (clean.startsWith('6') || clean.startsWith('5') || clean.startsWith('9')) return 'sh'
  if (clean.startsWith('8') || clean.startsWith('4')) return 'bj'
  return 'sz'
}

function normalizeSymbol(symbol: string): { market: 'sh' | 'sz' | 'bj'; code: string; full: string } {
  const lower = symbol.toLowerCase()
  if (lower.startsWith('sh') || lower.startsWith('sz') || lower.startsWith('bj')) {
    const market = lower.slice(0, 2) as 'sh' | 'sz' | 'bj'
    const code = lower.slice(2)
    return { market, code, full: `${market}${code}` }
  }
  const market = detectMarket(symbol)
  return { market, code: symbol, full: `${market}${symbol}` }
}

/** 东方财富的 secid 编码：1=上证, 0=深证/北交所（北交所 secid 前缀待验证，先按 0 处理） */
function eastmoneySecid(symbol: string): string {
  const { market, code } = normalizeSymbol(symbol)
  return `${market === 'sh' ? 1 : 0}.${code}`
}

/**
 * 主源：东方财富 clist 接口。批量好，UTF-8 JSON，免费无 key。
 * fields:
 *   f2  最新价 (×100)
 *   f3  涨跌幅 (%)
 *   f4  涨跌额 (×100)
 *   f5  成交量 (手)
 *   f6  成交额
 *   f12 代码
 *   f14 名称
 *   f15 最高 (×100)
 *   f16 最低 (×100)
 *   f17 开盘 (×100)
 *   f18 昨收 (×100)
 */
export async function fetchEastmoney(symbols: string[]): Promise<StockQuote[]> {
  if (symbols.length === 0) return []
  const secids = symbols.map(eastmoneySecid).join(',')
  const url = `https://push2.eastmoney.com/api/qt/clist/get?secids=${secids}&fields=f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18&fltt=2&fid=&pn=1&pz=50`

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://quote.eastmoney.com/',
    },
  })
  if (!res.ok) throw new Error(`东方财富 HTTP ${res.status}`)
  const data = await res.json() as any
  const diff = data?.data?.diff
  if (!Array.isArray(diff)) return []
  return diff.map((d: any) => {
    const current = Number(d.f2) || 0
    const prevClose = Number(d.f18) || 0
    return {
      symbol: String(d.f12),
      name: String(d.f14),
      current,
      prev_close: prevClose,
      open: Number(d.f17) || undefined,
      high: Number(d.f15) || undefined,
      low: Number(d.f16) || undefined,
      change: Number(d.f4) || 0,
      change_pct: Number(d.f3) || 0,
      volume: Number(d.f5) || undefined,
      amount: Number(d.f6) || undefined,
      ts: Date.now(),
    }
  })
}

/**
 * 备份源：新浪 hq.sinajs.cn (GBK 编码，需要 Referer)。
 * 接口形式：
 *   GET /list=sh600519,sz000001
 * 响应:
 *   var hq_str_sh600519="贵州茅台,1505.0,1500.0,...,date,time";
 *
 * 字段顺序: name, open, prev_close, current, high, low, b1, a1, volume, amount,
 *           b1_vol, b1_p, b2_vol, b2_p, ..., date, time
 */
export async function fetchSina(symbols: string[]): Promise<StockQuote[]> {
  if (symbols.length === 0) return []
  const list = symbols.map(s => normalizeSymbol(s).full).join(',')
  const url = `https://hq.sinajs.cn/list=${list}`

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://finance.sina.com.cn/',
    },
  })
  if (!res.ok) throw new Error(`新浪 HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  // GBK 解码 — Node 22+ 的 TextDecoder 默认带 ICU
  const text = new TextDecoder('gbk').decode(buf)
  const lines = text.split(/;\s*/).map(l => l.trim()).filter(Boolean)
  const out: StockQuote[] = []
  for (const ln of lines) {
    const m = ln.match(/var hq_str_(\w+)="([^"]*)"/)
    if (!m) continue
    const fullSym = m[1]
    const parts = m[2].split(',')
    if (parts.length < 4 || !parts[0]) continue // empty quote = invalid symbol
    const name = parts[0]
    const open = Number(parts[1])
    const prevClose = Number(parts[2])
    const current = Number(parts[3])
    const high = Number(parts[4])
    const low = Number(parts[5])
    const volume = Number(parts[8])
    const amount = Number(parts[9])
    const change = current - prevClose
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0
    out.push({
      symbol: fullSym.replace(/^(sh|sz)/i, ''),
      name,
      current,
      prev_close: prevClose,
      open: isFinite(open) ? open : undefined,
      high: isFinite(high) ? high : undefined,
      low: isFinite(low) ? low : undefined,
      change,
      change_pct: changePct,
      volume: isFinite(volume) ? volume : undefined,
      amount: isFinite(amount) ? amount : undefined,
      ts: Date.now(),
    })
  }
  return out
}

/** Try eastmoney first, fall back to sina. */
export async function fetchStockQuotes(symbols: string[]): Promise<StockQuote[]> {
  if (symbols.length === 0) return []
  // 非交易时段不查询实时行情，避免无效 API 调用（休市时无实时数据）
  if (!isMarketOpen()) {
    console.log('[stock-cn] 市场休市，跳过实时行情查询')
    return []
  }
  try {
    const q = await fetchEastmoney(symbols)
    if (q.length > 0) return q
  } catch (err) {
    console.error('[stock-cn] eastmoney failed, falling back to sina:', err)
  }
  return fetchSina(symbols)
}

export async function fetchStockQuote(symbol: string): Promise<StockQuote | null> {
  const arr = await fetchStockQuotes([symbol])
  return arr[0] || null
}

/** Is the A-share market open right now? (Approximate: weekday + 9:30-11:30 / 13:00-15:00 CST) */
export function isMarketOpen(now: Date = new Date()): boolean {
  // 直接用 UTC 偏移计算北京时间，避免 toLocaleString → new Date 的时区信息丢失。
  // 北京时间 = UTC+8，无论用户本机时区如何都能得到正确的上海时间。
  const beijingMs = now.getTime() + 8 * 3600_000
  const beijing = new Date(beijingMs)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false // Sun, Sat
  const mins = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (mins >= 9 * 60 + 30 && mins <= 11 * 60 + 30) ||
         (mins >= 13 * 60 && mins <= 15 * 60)
}
