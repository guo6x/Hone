import { execFileSync } from 'node:child_process'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent } from 'undici'

let cachedProxy

export function getProxyUrl() {
  if (cachedProxy !== undefined) return cachedProxy

  cachedProxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    getWindowsProxyUrl() ||
    ''

  return cachedProxy || undefined
}

export function websocketOptions() {
  const proxy = getProxyUrl()
  return proxy ? { agent: new HttpsProxyAgent(proxy) } : {}
}

export function fetchWithProxy(url, options = {}) {
  const proxy = getProxyUrl()
  return fetch(url, proxy ? { ...options, dispatcher: new ProxyAgent(proxy) } : options)
}

function getWindowsProxyUrl() {
  if (process.platform !== 'win32') return undefined

  const readValue = name => {
    try {
      const output = execFileSync(
        'reg',
        [
          'query',
          String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`,
          '/v',
          name,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const line = output
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l.startsWith(name))
      return line?.split(/\s+/).at(-1)
    } catch {
      return undefined
    }
  }

  const enabled = readValue('ProxyEnable')
  if (enabled !== '0x1' && enabled !== '1') return undefined

  const raw = readValue('ProxyServer')?.trim()
  if (!raw) return undefined

  const endpoint = raw.includes(';')
    ? raw
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith('https=') || part.startsWith('http='))
        ?.replace(/^https?=/, '')
    : raw

  if (!endpoint) return undefined
  return endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint
    : `http://${endpoint}`
}
