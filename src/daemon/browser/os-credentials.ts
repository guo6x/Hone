/**
 * OS-level credential encryption.
 * Phase 5 upgrade from AES hostname-key to platform-native encryption:
 *   Windows → DPAPI (via PowerShell)
 *   macOS   → Keychain (via /usr/bin/security)
 *   Linux   → libsecret (via secret-tool)
 *
 * Falls back to AES-256-CBC with hostname-derived key when native tools
 * are unavailable.
 */
import { execSync } from 'child_process'
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto'
import os from 'os'

const ALGORITHM = 'aes-256-cbc'
const KEY_LENGTH = 32
const IV_LENGTH = 16

// ── Platform detection ──

const platform = os.platform() as 'win32' | 'darwin' | 'linux'

// ── AES fallback (same as original) ──

function fallbackKey(): Buffer {
  const hostname = process.env.COMPUTERNAME || process.env.HOSTNAME || 'hone'
  return scryptSync(hostname, 'hone-browser-credentials-v1', KEY_LENGTH)
}

function fallbackEncrypt(plaintext: string): string {
  const key = fallbackKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

function fallbackDecrypt(ciphertext: string): string {
  const key = fallbackKey()
  const [ivHex, dataHex] = ciphertext.split(':')
  if (!ivHex || !dataHex) throw new Error('Invalid ciphertext format')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return decrypted.toString('utf-8')
}

// ── DPAPI (Windows) ──

function dpapiEncrypt(plaintext: string): string {
  const base64 = Buffer.from(plaintext, 'utf-8').toString('base64')
  const ps = `
$bytes = [System.Convert]::FromBase64String('${base64}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Convert]::ToBase64String($protected)
`
  return execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    windowsHide: true,
  }).trim()
}

function dpapiDecrypt(ciphertext: string): string {
  const ps = `
$bytes = [System.Convert]::FromBase64String('${ciphertext}')
$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($unprotected)
`
  return execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    windowsHide: true,
  }).trim()
}

// ── Keychain (macOS) ──

function keychainEncrypt(plaintext: string): string {
  const id = `hone_cred_${Date.now()}`
  execSync(`security add-generic-password -a hone -s ${id} -w "${plaintext.replace(/"/g, '\\"')}" -U`, {
    encoding: 'utf-8',
  })
  return id // store the keychain item id as the encrypted value
}

function keychainDecrypt(ciphertext: string): string {
  return execSync(`security find-generic-password -a hone -s ${ciphertext} -w`, {
    encoding: 'utf-8',
  }).trim()
}

// ── libsecret (Linux) ──

function libsecretEncrypt(plaintext: string): string {
  const id = `hone_cred_${Date.now()}`
  execSync(`echo "${plaintext.replace(/"/g, '\\"')}" | secret-tool store --label="Hone Credential" service hone id ${id}`, {
    encoding: 'utf-8',
  })
  return id
}

function libsecretDecrypt(ciphertext: string): string {
  return execSync(`secret-tool lookup service hone id ${ciphertext}`, {
    encoding: 'utf-8',
  }).trim()
}

// ── Tool availability checks ──

let dpapiAvailable: boolean | null = null
let keychainAvailable: boolean | null = null
let libsecretAvailable: boolean | null = null

function checkDpapi(): boolean {
  if (dpapiAvailable !== null) return dpapiAvailable
  try {
    // Quick test: encrypt/decrypt a known string
    const test = dpapiEncrypt('hone-test')
    const decrypted = dpapiDecrypt(test)
    dpapiAvailable = decrypted === 'hone-test'
  } catch {
    dpapiAvailable = false
  }
  return dpapiAvailable
}

function checkKeychain(): boolean {
  if (keychainAvailable !== null) return keychainAvailable
  try {
    execSync('security find-generic-password -a hone -s hone_test_key 2>/dev/null', { encoding: 'utf-8' })
  } catch {
    // Keychain is available — the lookup failed because the key doesn't exist
  }
  try {
    // Try to use it
    execSync('security add-generic-password -a hone -s hone_test_key -w testval -U 2>/dev/null', { encoding: 'utf-8' })
    const val = execSync('security find-generic-password -a hone -s hone_test_key -w 2>/dev/null', { encoding: 'utf-8' }).trim()
    execSync('security delete-generic-password -a hone -s hone_test_key 2>/dev/null', { encoding: 'utf-8' })
    keychainAvailable = val === 'testval'
  } catch {
    keychainAvailable = false
  }
  return keychainAvailable
}

function checkLibsecret(): boolean {
  if (libsecretAvailable !== null) return libsecretAvailable
  try {
    execSync('secret-tool lookup service hone id hone_test 2>/dev/null', { encoding: 'utf-8' })
  } catch {}
  try {
    execSync('echo testval | secret-tool store --label="Hone Test" service hone id hone_test 2>/dev/null', { encoding: 'utf-8' })
    const val = execSync('secret-tool lookup service hone id hone_test 2>/dev/null', { encoding: 'utf-8' }).trim()
    execSync('secret-tool clear service hone id hone_test 2>/dev/null', { encoding: 'utf-8' })
    libsecretAvailable = val === 'testval'
  } catch {
    libsecretAvailable = false
  }
  return libsecretAvailable
}

// ── Public API ──

export type EncryptMethod = 'dpapi' | 'keychain' | 'libsecret' | 'aes-fallback'

let cachedMethod: EncryptMethod | null = null

export function getEncryptMethod(): EncryptMethod {
  if (cachedMethod) return cachedMethod

  if (platform === 'win32' && checkDpapi()) {
    cachedMethod = 'dpapi'
  } else if (platform === 'darwin' && checkKeychain()) {
    cachedMethod = 'keychain'
  } else if (platform === 'linux' && checkLibsecret()) {
    cachedMethod = 'libsecret'
  } else {
    cachedMethod = 'aes-fallback'
  }

  return cachedMethod
}

export function osEncrypt(plaintext: string): string {
  const method = getEncryptMethod()
  const prefix = `${method}:`

  switch (method) {
    case 'dpapi':
      return prefix + dpapiEncrypt(plaintext)
    case 'keychain':
      return prefix + keychainEncrypt(plaintext)
    case 'libsecret':
      return prefix + libsecretEncrypt(plaintext)
    default:
      return prefix + fallbackEncrypt(plaintext)
  }
}

export function osDecrypt(ciphertext: string): string {
  const colonIdx = ciphertext.indexOf(':')
  if (colonIdx === -1) {
    // Legacy format (no prefix) — try fallback
    return fallbackDecrypt(ciphertext)
  }

  const method = ciphertext.slice(0, colonIdx)
  const payload = ciphertext.slice(colonIdx + 1)

  switch (method) {
    case 'dpapi':
      return dpapiDecrypt(payload)
    case 'keychain':
      return keychainDecrypt(payload)
    case 'libsecret':
      return libsecretDecrypt(payload)
    default:
      return fallbackDecrypt(payload)
  }
}

/** Re-encrypt using the current best method (for upgrading legacy credentials). */
export function osReEncrypt(ciphertext: string): string {
  return osEncrypt(osDecrypt(ciphertext))
}
