import assert from 'node:assert/strict'
import { RelayRoom } from './relay-room.js'

class FakeStorage {
  constructor(values = new Map()) {
    this.values = values
  }
  async get(key) { return this.values.get(key) }
  async put(key, value) { this.values.set(key, structuredClone(value)) }
  async delete(key) { this.values.delete(key) }
  async setAlarm(value) { this.values.set('__alarm__', value) }
}

class FakeSocket {
  constructor() {
    this.sent = []
    this.closed = null
    this.attachment = null
  }
  send(value) { this.sent.push(JSON.parse(value)) }
  close(code, reason) { this.closed = { code, reason } }
  serializeAttachment(value) { this.attachment = structuredClone(value) }
  deserializeAttachment() { return structuredClone(this.attachment) }
}

class FakeContext {
  constructor(storage, sockets = []) {
    this.storage = storage
    this.sockets = sockets
  }
  blockConcurrencyWhile(callback) { return callback() }
  getWebSockets() { return this.sockets }
  acceptWebSocket(socket) { this.sockets.push(socket) }
}

function last(socket) {
  return socket.sent.at(-1)
}

async function createRoom(storage, sockets = []) {
  const ctx = new FakeContext(storage, sockets)
  const room = new RelayRoom(ctx, {})
  await room.ready
  return room
}

async function main() {
  const storage = new FakeStorage()
  const room = await createRoom(storage)
  const gateway = new FakeSocket()
  const invalidClient = new FakeSocket()

  await room.webSocketMessage(invalidClient, JSON.stringify({
    type: 'register', role: 'client', pairingId: 'pairing-12345678', pairingCode: '123456',
  }))
  assert.equal(invalidClient.closed?.code, 4003)

  await room.webSocketMessage(gateway, JSON.stringify({
    type: 'register',
    role: 'gateway',
    machineId: 'gateway-12345678',
    machineName: 'Test Gateway',
    token: 'g'.repeat(64),
    pairingId: 'pairing-12345678',
    pairingCode: '123456',
  }))
  assert.equal(last(gateway).type, 'registered')

  const candidate = new FakeSocket()
  await room.webSocketMessage(candidate, JSON.stringify({
    type: 'register', role: 'client', pairingId: 'pairing-12345678', pairingCode: '123456',
  }))
  assert.equal(last(candidate).type, 'pairing_required')
  const pairingRequest = last(gateway)
  assert.equal(pairingRequest.type, 'pairing_request')

  await room.webSocketMessage(gateway, JSON.stringify({
    type: 'pairing_response', clientId: pairingRequest.clientId, approved: true,
  }))
  const approved = last(candidate)
  assert.equal(approved.type, 'registered')
  assert.ok(approved.deviceId)
  assert.ok(approved.deviceToken)

  await room.webSocketMessage(candidate, JSON.stringify({
    type: 'message', target: 'gateway', payload: { text: 'hello' },
  }))
  const forwarded = last(gateway)
  assert.equal(forwarded.from, 'client')
  assert.equal(forwarded.clientId, approved.deviceId)

  await room.webSocketMessage(gateway, JSON.stringify({
    type: 'message', target: 'client', clientId: approved.deviceId, payload: { text: 'reply' },
  }))
  assert.equal(last(candidate).payload.text, 'reply')
  assert.equal(last(candidate).from, 'gateway')

  await room.webSocketMessage(gateway, JSON.stringify({
    type: 'task_complete', result: 'missing target',
  }))
  assert.equal(last(gateway).type, 'error')

  const reconnect = new FakeSocket()
  await room.webSocketMessage(reconnect, JSON.stringify({
    type: 'register',
    role: 'client',
    deviceId: approved.deviceId,
    deviceToken: approved.deviceToken,
  }))
  assert.equal(last(reconnect).type, 'registered')
  assert.equal(last(reconnect).deviceId, approved.deviceId)

  const resumed = await createRoom(storage, [gateway, reconnect])
  await resumed.webSocketMessage(reconnect, JSON.stringify({
    type: 'message', target: 'gateway', payload: { text: 'after hibernation' },
  }))
  assert.equal(last(gateway).payload.text, 'after hibernation')

  console.log('RelayRoom protocol tests: 18 passed')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
