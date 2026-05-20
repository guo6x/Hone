/**
 * Relay end-to-end test.
 * Usage: node relay/test-relay.mjs
 */
const RELAY = 'wss://hone-relay.marsailleippi79.workers.dev'
const ROOM = 'test-' + Date.now()

let passed = 0, failed = 0
function ok(n) { console.log(`  ✅ ${n}`); passed++ }
function fail(n, r) { console.log(`  ❌ ${n}: ${r}`); failed++ }
function log(label, msg) { /* console.log(`  [${label}] ${JSON.stringify(msg)}`) */ }
function send(ws, msg) { ws.send(JSON.stringify(msg)) }

// ── Test 1: Health ──
async function testHealth() {
  console.log('\n[1] Health check')
  try {
    const res = await fetch(`${RELAY.replace('wss:', 'https:')}/health`)
    const data = await res.json()
    if (data.status === 'ok' && data.version === 'v2') ok(`health: ${data.status} v${data.version}`)
    else fail('health', JSON.stringify(data))
  } catch (e) { fail('health', e.message) }
}

// ── Test 2: Gateway + Client → message routing ──
function testRouting() {
  return new Promise((resolve) => {
    console.log('\n[2] Gateway ↔ Client message routing')
    const timeout = setTimeout(() => { fail('routing', 'timeout'); gw.close(); resolve() }, 15000)

    const gw = new WebSocket(`${RELAY}/connect/${ROOM}`)
    let stage = 0

    gw.onopen = () => {
      send(gw, { type: 'register', role: 'gateway', machineId: 'gw1', machineName: 'test-gw' })
    }

    gw.onmessage = (e) => {
      const msg = JSON.parse(e.data); log('GW', msg)

      if (msg.type === 'registered') { ok('gateway registered'); stage = 1 }

      if (msg.type === 'pairing_request') {
        ok(`pairing request: ${msg.clientId.slice(0,8)}...`)
        stage = 2
        send(gw, { type: 'pairing_response', clientId: msg.clientId, approved: true })
      }

      if (msg.type === 'message') {
        ok(`gateway received: ${msg.payload?.text || ''}`)
        stage = 4
        send(gw, { type: 'message', target: 'client', clientId: msg.clientId, payload: { text: '收到!' } })
        clearTimeout(timeout)
        setTimeout(() => { gw.close(); resolve() }, 300)
      }
    }
    gw.onerror = () => { fail('routing', 'gw error'); resolve() }

    // Client connects after short delay
    setTimeout(() => {
      const cl = new WebSocket(`${RELAY}/connect/${ROOM}`)
      cl.onopen = () => send(cl, { type: 'register', role: 'client', pairingCode: '123456' })
      cl.onmessage = (ce) => {
        const msg = JSON.parse(ce.data); log('CL', msg)
        if (msg.type === 'pairing_required') ok('client awaiting pairing')
        if (msg.type === 'registered') {
          ok('client approved'); stage = 3
          send(cl, { type: 'message', target: 'gateway', payload: { text: '你好 Hone' } })
        }
        if (msg.type === 'message') {
          ok(`client got reply: ${msg.payload?.text || ''}`)
          cl.close()
        }
      }
    }, 300)
  })
}

// ── Test 3: from field is correctly stamped by relay ──
function testFromField() {
  return new Promise((resolve) => {
    const ROOM3 = 'test-from-' + Date.now()
    console.log('\n[3] Relay stamps from field (prevents regression)')
    const timeout = setTimeout(() => { fail('from-field', 'timeout'); gw.close(); resolve() }, 15000)

    const gw = new WebSocket(`${RELAY}/connect/${ROOM3}`)
    let clientId = null

    gw.onopen = () => send(gw, { type: 'register', role: 'gateway', machineId: 'gw-from', machineName: 'from-test' })

    gw.onmessage = (e) => {
      const msg = JSON.parse(e.data); log('GW', msg)

      if (msg.type === 'registered') ok('gateway registered for from-test')

      if (msg.type === 'pairing_request') {
        clientId = msg.clientId
        send(gw, { type: 'pairing_response', clientId, approved: true })
      }

      if (msg.type === 'message') {
        // 3a: Client→Gateway must have from:'client' (relay stamps, prevents spoofing)
        if (msg.from === 'client') ok('client→gateway has from:"client"')
        else fail('client→gateway from field', `expected "client", got "${msg.from}"`)

        // Reply back so client can check gateway→client direction
        send(gw, { type: 'message', target: 'client', clientId: msg.clientId, payload: { text: 'pong' } })
      }
    }
    gw.onerror = () => { fail('from-field', 'gw error'); resolve() }

    // Client
    setTimeout(() => {
      const cl = new WebSocket(`${RELAY}/connect/${ROOM3}`)
      cl.onopen = () => send(cl, { type: 'register', role: 'client', pairingCode: '123456' })

      cl.onmessage = (ce) => {
        const msg = JSON.parse(ce.data); log('CL', msg)

        if (msg.type === 'registered') {
          ok('client approved for from-test')
          // Send a message AND try to spoof from:'gateway' — relay must overwrite it
          send(cl, { type: 'message', target: 'gateway', from: 'gateway', payload: { text: 'hello' } })
        }

        if (msg.type === 'message') {
          // 3b: Gateway→Client must have from:'gateway'
          if (msg.from === 'gateway') ok('gateway→client has from:"gateway"')
          else fail('gateway→client from field', `expected "gateway", got "${msg.from}"`)

          clearTimeout(timeout)
          setTimeout(() => { cl.close(); gw.close(); resolve() }, 200)
        }
      }
      cl.onerror = () => { fail('from-field', 'cl error'); resolve() }
    }, 300)
  })
}

// ── Main ──
async function main() {
  console.log(`Hone Relay E2E — ${new Date().toISOString()}`)
  await testHealth()
  await testRouting()
  await testFromField()
  console.log(`\n${'─'.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('Crashed:', e); process.exit(1) })
