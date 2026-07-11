/**
 * Credential storage for browser automation.
 * Stores service credentials encrypted at rest in ~/.hone/credentials.json.
 * Phase 5: OS-level encryption (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 * Falls back to AES-256-CBC with hostname-derived key when OS tools unavailable.
 */
import fs from 'fs/promises'
import path from 'path'
import * as os from 'os'
import type { CredentialEntry } from './types.js'
import { osEncrypt, osDecrypt, osReEncrypt, getEncryptMethod } from './os-credentials.js'

function getDataDir(): string {
  const base = process.env.HONE_DATA_DIR || path.join(os.homedir(), '.hone')
  return path.join(base, 'browser')
}

function getCredentialsPath(): string {
  return path.join(getDataDir(), 'credentials.json')
}

function encrypt(plaintext: string): string {
  return osEncrypt(plaintext)
}

function decrypt(ciphertext: string): string {
  return osDecrypt(ciphertext)
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true })
}

async function loadAll(): Promise<CredentialEntry[]> {
  try {
    await ensureDir()
    const raw = await fs.readFile(getCredentialsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

async function saveAll(entries: CredentialEntry[]): Promise<void> {
  await ensureDir()
  await fs.writeFile(getCredentialsPath(), JSON.stringify(entries, null, 2))
}

/** Store a new credential with encrypted password. */
export async function addCredential(
  service: string,
  username: string,
  password: string,
  notes = '',
): Promise<CredentialEntry> {
  const entries = await loadAll()
  const entry: CredentialEntry = {
    id: `cred_${Date.now()}`,
    service,
    username,
    password: encrypt(password),
    notes,
    createdAt: Date.now(),
  }
  entries.push(entry)
  await saveAll(entries)
  return entry
}

/** Retrieve and decrypt a credential. */
export async function getCredential(id: string): Promise<{ username: string; password: string } | null> {
  const entries = await loadAll()
  const entry = entries.find(e => e.id === id)
  if (!entry) return null
  return {
    username: entry.username,
    password: decrypt(entry.password),
  }
}

/** List all credentials (passwords remain encrypted). */
export async function listCredentials(): Promise<CredentialEntry[]> {
  return loadAll()
}

/** Delete a credential. */
export async function deleteCredential(id: string): Promise<boolean> {
  const entries = await loadAll()
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return false
  entries.splice(idx, 1)
  await saveAll(entries)
  return true
}
