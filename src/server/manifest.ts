import { createSign, generateKeyPairSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getEffectivePermissions } from './db/index.js';
import type { AccessLevel } from './db/index.js';

export interface ManifestTools {
  [toolId: string]: { access: AccessLevel; scope: object };
}

export interface Manifest {
  version: number;
  agentId: string;
  issuedAt: string;
  expiresAt: string;
  tools: ManifestTools;
  signature: string | null;
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

// Manifest validity window
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Key management ────────────────────────────────────────────────────────────

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

export function saveKeyPair(keysDir: string, keys: KeyPair): void {
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, 'private.pem'), keys.privateKey, { mode: 0o600 });
  writeFileSync(join(keysDir, 'public.pem'), keys.publicKey, { mode: 0o644 });
}

export function loadKeyPair(keysDir: string): KeyPair | null {
  const privPath = join(keysDir, 'private.pem');
  const pubPath = join(keysDir, 'public.pem');
  if (!existsSync(privPath) || !existsSync(pubPath)) return null;
  return {
    privateKey: readFileSync(privPath, 'utf8'),
    publicKey: readFileSync(pubPath, 'utf8'),
  };
}

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * Sign the manifest payload (everything except the signature field itself).
 * Produces a deterministic base64 RSA-SHA256 signature.
 */
function signPayload(payload: Omit<Manifest, 'signature'>, privateKey: string): string {
  const signer = createSign('SHA256');
  signer.update(JSON.stringify(payload));
  signer.end();
  return signer.sign(privateKey, 'base64');
}

// ── Manifest generation ───────────────────────────────────────────────────────

/**
 * Build and sign a manifest for an agent based on its current effective permissions.
 * If no privateKey is provided the signature field will be null (dev/no-keys mode).
 */
export function buildManifest(
  agentId: string,
  version: number,
  privateKey: string | null,
): Manifest {
  const permissions = getEffectivePermissions(agentId);

  const tools: ManifestTools = {};
  for (const p of permissions) {
    tools[p.tool_id] = {
      access: p.access_level,
      scope: p.scope_override ?? p.tool_default_scope ?? {},
    };
  }

  const now = Date.now();
  const payload: Omit<Manifest, 'signature'> = {
    version,
    agentId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MANIFEST_TTL_MS).toISOString(),
    tools,
  };

  return {
    ...payload,
    signature: privateKey ? signPayload(payload, privateKey) : null,
  };
}
