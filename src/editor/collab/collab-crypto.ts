/**
 * Collaboration-session crypto: per-room symmetric encryption and the
 * share-code format.
 *
 * Every update, snapshot, and presence blob a session sends is sealed
 * with the room's AES-256-GCM key before it leaves the client; the
 * relay stores and forwards ciphertext it cannot read (the same trust
 * envelope as card sharing's sealed boxes). The room key never reaches
 * the server — it travels only inside invites (sealed-box pairing
 * messages) or a share code the user hands over directly.
 *
 * Sealed layout: 12-byte random IV ‖ GCM ciphertext+tag. A fresh IV per
 * blob is mandatory for GCM; 12 bytes is the GCM-native size.
 *
 * Uses WebCrypto (`crypto.subtle`), available in the browser, the
 * Electron renderer, and Node ≥16 — the same code path everywhere.
 */

export const ROOM_KEY_BYTES = 32;

const SHARE_CODE_PREFIX = 'cmshare1';

export function generateRoomKeyBytes(): Uint8Array {
  const key = new Uint8Array(ROOM_KEY_BYTES);
  crypto.getRandomValues(key);
  return key;
}

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ROOM_KEY_BYTES) {
    throw new Error('room key must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptBlob(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return out;
}

/** Throws on tampered or wrong-key input (GCM tag failure). */
export async function decryptBlob(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.byteLength < 13) throw new Error('sealed blob too short');
  const iv = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource),
  );
}

// --- base64 / base64url (portable: browser + Node, no Buffer) ---

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit guard
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(b64);
}

// --- share codes ---

/** `cmshare1.<roomId>.<base64url room key>` — the out-of-band invite
 *  fallback for non-partners (paste or QR). Possession of the code IS
 *  the capability to join. */
export function encodeShareCode(roomId: string, keyBytes: Uint8Array): string {
  return `${SHARE_CODE_PREFIX}.${roomId}.${toBase64Url(keyBytes)}`;
}

export function decodeShareCode(code: string): { roomId: string; keyBytes: Uint8Array } | null {
  const parts = code.trim().split('.');
  if (parts.length !== 3 || parts[0] !== SHARE_CODE_PREFIX) return null;
  const roomId = parts[1]!;
  if (!/^[0-9a-f]{16,64}$/.test(roomId)) return null;
  try {
    const keyBytes = fromBase64Url(parts[2]!);
    if (keyBytes.byteLength !== ROOM_KEY_BYTES) return null;
    return { roomId, keyBytes };
  } catch {
    return null;
  }
}
