// The envelope: JSON → gzip → AES-256-GCM, key derived from a root key the server never sees.
// Everything here is async because SubtleCrypto is; nothing is exported as raw bytes except at
// signup, where the root key is created.

const OP_INFO = 'varia/op';
const NONCE = 12;

/** 32 random bytes. Only exists in memory, at signup and when pasting an enrolment code. */
export function newRootKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The AES key is non-extractable: an XSS can decrypt what it can already read, not carry the key away. */
export async function opKey(root: Uint8Array): Promise<CryptoKey> {
  const hkdf = await crypto.subtle.importKey('raw', root as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(OP_INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A stable, non-secret fingerprint of a token: names the account a pull cursor belongs to. */
export async function accountTag(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Returns base64 of `nonce ‖ ciphertext`, which is what the server stores as an opaque string. */
export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const plain = await gzip(new TextEncoder().encode(JSON.stringify(value)));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain as BufferSource));
  const payload = new Uint8Array(nonce.length + sealed.length);
  payload.set(nonce);
  payload.set(sealed, nonce.length);
  return bytesToBase64(payload);
}

/** Throws on a wrong key, a truncated payload or a corrupted one: GCM authenticates. */
export async function openSealed(key: CryptoKey, payload: string): Promise<unknown> {
  const bytes = base64ToBytes(payload);
  if (bytes.length <= NONCE) throw new Error('payload too short');
  const body: BufferSource = bytes.slice(NONCE);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, NONCE) }, key, body);
  return JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(plain))));
}

// ---------------------------------------------------------------- the two secrets

/** The key as the user copies it: 52 base32 characters, no padding, easy to read out loud. */
export function formatRootKey(root: Uint8Array): string {
  return base32Encode(root);
}

export function parseRootKey(text: string): Uint8Array {
  const bytes = base32Decode(text);
  if (bytes.length !== 32) throw new Error('the key must be 32 bytes of base32');
  return bytes;
}

// ---------------------------------------------------------------- helpers

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b ?? 0) >> 4];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let [buffer, bits, at] = [0, 0, 0];
  for (const char of clean) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (buffer >> bits) & 255;
    }
  }
  return bytes.subarray(0, at);
}

/** RFC 4648 base32 without padding: 52 chars for 32 bytes, and safe to read out loud. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let [buffer, bits] = [0, 0];
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  let [buffer, bits] = [0, 0];
  for (const char of text.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    buffer = (buffer << 5) | B32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}
