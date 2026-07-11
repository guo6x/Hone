/**
 * Relay v3 end-to-end protocol test.
 *
 * Start a local Worker first with `npx wrangler dev --local --port 8790`, then:
 *   RELAY_URL=ws://127.0.0.1:8790 node test-relay.mjs
 *
 * The same test can run against a deployed v3 Worker by supplying its URL.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const relay = (process.env.RELAY_URL || 'ws://127.0.0.1:8790').replace(/\/$/, '')
const room = `test-${randomUUID().replace(/-/g, '')}`
const gatewayToken = randomBytes(32).toString('hex')
const pairingId = `pair-${randomUUID().replace(/-/g, '')}`
const pairingCode = '123456'

let passed = 0
let failed = 0

function pass(label) {
  console.log(`  PASS ${label}`)
  passed++
}

function fail(label, error) {
  console.log(`  FAIL ${label}: ${error instanceof Error ? error.message : error}`)
  failed++
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function endpoint(name) {
  return `${relay}/connect/${name}`
}

async function openPeer(url) {
  const ws = new WebSocket(url)
  const messages = []
  const waiters = []
  let closed = null

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket open timeout: ${url}`)), 8_000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', error => { clearTimeout(timer); reject(error) })
  })

  ws.on('message', data => {
    let message
    try { message = JSON.parse(data.toString()) } catch { return }
    const index = waiters.findIndex(waiter => waiter.predicate(message))
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    } else {
      messages.push(message)
    }
  })
  ws.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() }
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`WebSocket closed ${code}: ${closed.reason}`))
    }
  })

  await ready

  return {
    ws,
    send(message) { ws.send(JSON.stringify(message)) },
    async next(predicate, timeoutMs = 8_000) {
      const existing = messages.findIndex(predicate)
      if (existing >= 0) return messages.splice(existing, 1)[0]
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(waiter => waiter.resolve === resolve)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('Timed out waiting for relay message'))
        }, timeoutMs)
        waiters.push({ predicate, resolve, reject, timer })
      })
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return
      const done = new Promise(resolve => ws.once('close', resolve))
      ws.close()
      await Promise.race([done, new Promise(resolve => setTimeout(resolve, 1_000))])
    },
  }
}

async function testHealth() {
  const health = relay.replace(/^ws/, 'http') + '/health'
  const response = await fetch(health)
  const body = await response.json()
  assert(response.ok, `health status ${response.status}`)
  assert(body.status === 'ok' && body.version === 'v3', `unexpected health ${JSON.stringify(body)}`)
  pass('health endpoint reports v3')
}

async function testPairingAndRouting() {
  const gateway = await openPeer(endpoint(room))
  const client = await openPeer(endpoint(room))
  let reconnect
  try {
    gateway.send({
      type: 'register', role: 'gateway', machineId: 'gateway-test', machineName: 'Gateway Test',
      token: gatewayToken, pairingId, pairingCode,
    })
    await gateway.next(message => message.type === 'registered')
    pass('gateway authenticates with a per-room credential')

    client.send({ type: 'register', role: 'client', pairingId, pairingCode })
    await client.next(message => message.type === 'pairing_required')
    const request = await gateway.next(message => message.type === 'pairing_request')
    assert(request.clientId, 'pairing request did not contain a client ID')
    pass('pairing challenge reaches the gateway')

    gateway.send({ type: 'pairing_response', clientId: request.clientId, approved: true })
    const registered = await client.next(message => message.type === 'registered')
    assert(registered.deviceId && registered.deviceToken, 'approved client did not receive device credentials')
    pass('approved device receives persistent credentials')

    client.send({ type: 'message', target: 'gateway', from: 'gateway', payload: { text: 'hello' } })
    const forwarded = await gateway.next(message => message.type === 'message')
    assert(forwarded.from === 'client', `client origin was not stamped: ${forwarded.from}`)
    assert(forwarded.clientId === registered.deviceId, 'client ID was not stamped')
    pass('client messages are origin-stamped before reaching the gateway')

    gateway.send({
      type: 'message', target: 'client', clientId: registered.deviceId, payload: { text: 'targeted reply' },
    })
    const reply = await client.next(message => message.type === 'message')
    assert(reply.from === 'gateway' && reply.payload?.text === 'targeted reply', 'targeted reply failed')
    pass('gateway replies are routed only to the requesting device')

    gateway.send({ type: 'task_complete', result: 'no target' })
    const routingError = await gateway.next(message => message.type === 'error')
    assert(String(routingError.message).includes('requires a target'), 'unaddressed gateway message was accepted')
    pass('unaddressed gateway messages are rejected')

    const deviceId = registered.deviceId
    const deviceToken = registered.deviceToken
    await client.close()
    reconnect = await openPeer(endpoint(room))
    reconnect.send({ type: 'register', role: 'client', deviceId, deviceToken })
    const restored = await reconnect.next(message => message.type === 'registered')
    assert(restored.deviceId === deviceId, 'persistent device reconnect failed')
    pass('device reconnects without retaining the one-time pairing code')
  } finally {
    await reconnect?.close()
    await client.close()
    await gateway.close()
  }
}

async function testInvalidGatewayCredential() {
  const invalidRoom = `invalid-${randomUUID().replace(/-/g, '')}`
  const ws = new WebSocket(endpoint(invalidRoom))
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('invalid gateway was not closed')), 8_000)
    ws.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }) })
    ws.once('error', reject)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ type: 'register', role: 'gateway', machineId: 'bad-gateway', token: 'too-short' }))
  const result = await closed
  assert(result.code === 4003, `expected 4003, got ${result.code}`)
  pass('gateway registration rejects missing or weak credentials')
}

async function main() {
  console.log(`Relay v3 E2E: ${relay}`)
  try { await testHealth() } catch (error) { fail('health endpoint', error) }
  try { await testPairingAndRouting() } catch (error) { fail('pairing and routing', error) }
  try { await testInvalidGatewayCredential() } catch (error) { fail('gateway credential validation', error) }
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
