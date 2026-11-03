// Shared formatters. Currency is resolved per sub-account from GHL (the
// location's `currency` flows through the session). Until the session sets it,
// we fall back to DEFAULT_CURRENCY. setCurrency() is called once from
// AuthContext on login. Change DEFAULT_CURRENCY here to switch the fallback.
export const DEFAULT_CURRENCY = 'GBP'
const DEFAULT_SYMBOL = '£'

let CURRENCY = DEFAULT_CURRENCY
let fmtMoney = makeMoneyFmt(CURRENCY)

function makeMoneyFmt(code) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: code, maximumFractionDigits: 0,
    })
  } catch {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: DEFAULT_CURRENCY, maximumFractionDigits: 0 })
  }
}

export function setCurrency(code) {
  if (!code || code === CURRENCY) return
  CURRENCY = code
  fmtMoney = makeMoneyFmt(code)
}

export const money = (v) => (v == null ? '—' : fmtMoney.format(Number(v)))

// The lone currency SYMBOL (e.g. "£", "$") for KPI prefixes / axis ticks,
// derived from the active currency via Intl so it tracks setCurrency().
export const currencySymbol = () => {
  try {
    return fmtMoney.formatToParts(0).find((p) => p.type === 'currency')?.value || DEFAULT_SYMBOL
  } catch {
    return DEFAULT_SYMBOL
  }
}

// Compact money for axis ticks, e.g. "£12k" / "$12k".
export const moneyK = (v) => `${currencySymbol()}${(Number(v) / 1000).toFixed(0)}k`

export const num = (v) => (v == null ? '—' : new Intl.NumberFormat(undefined).format(Number(v)))

export const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`)

// Hours → human ("3.5h", "2.1d"). Input is a number of hours.
export const hours = (h) => {
  if (h == null) return '—'
  const n = Number(h)
  if (n < 1) return `${Math.round(n * 60)}m`
  if (n < 48) return `${n.toFixed(1)}h`
  return `${(n / 24).toFixed(1)}d`
}

// Chart palette — colour-blind-safe, brand-led.
export const PALETTE = ['#3563e9', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']
export const STATUS_COLORS = { won: '#22c55e', lost: '#ef4444', open: '#3563e9', abandoned: '#94a3b8' }
