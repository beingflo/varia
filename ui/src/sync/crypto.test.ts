// Node provides Blob, CompressionStream and SubtleCrypto; the jsdom environment has no blob streams.
// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  base64ToBytes,
  bytesToBase64,
  enrolmentCode,
  newRootKey,
  openSealed,
  opKey,
  parseEnrolmentCode,
  seal,
} from './crypto';

describe('envelope', () => {
  it('round-trips a value and hides its content from anyone without the key', async () => {
    const key = await opKey(newRootKey());
    const payload = await seal(key, { kind: 'note_body', body: '# Lab notes' });

    expect(base64ToBytes(payload).length).toBeGreaterThan(28); // nonce plus at least a tag
    await expect(openSealed(key, payload)).resolves.toEqual({ kind: 'note_body', body: '# Lab notes' });

    const other = await opKey(newRootKey());
    await expect(openSealed(other, payload)).rejects.toThrow();
  });

  it('compresses before encrypting, and a tampered payload fails to open', async () => {
    const key = await opKey(newRootKey());
    const body = 'the retry loop coalesces '.repeat(80);
    const payload = await seal(key, { body });
    expect(payload.length).toBeLessThan(body.length / 4);

    const bytes = base64ToBytes(payload);
    bytes[bytes.length - 1] ^= 1;
    await expect(openSealed(key, bytesToBase64(bytes))).rejects.toThrow();
  });

  it('is non-extractable, so the key itself cannot leave the device', async () => {
    const key = await opKey(newRootKey());
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('enrolment code', () => {
  it('carries the token and the root key in one readable string', () => {
    const root = newRootKey();
    const code = enrolmentCode('0123456789abcdef', root);
    expect(code.startsWith('varia1.0123456789abcdef.')).toBe(true);

    const parsed = parseEnrolmentCode(code);
    expect(parsed.token).toBe('0123456789abcdef');
    expect([...parsed.root]).toEqual([...root]);
  });

  it('rejects anything else, including a code with the wrong key length', () => {
    expect(() => parseEnrolmentCode('nonsense')).toThrow();
    expect(() => parseEnrolmentCode('varia2.token.key')).toThrow();
    expect(() => parseEnrolmentCode(`varia1.token.${base32Encode(new Uint8Array(8))}`)).toThrow();
    expect(() => parseEnrolmentCode('varia1..')).toThrow();
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes and tolerates spaces, dashes and lower case', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const text = base32Encode(bytes);
    expect(text).toHaveLength(52);
    expect([...base32Decode(text)]).toEqual([...bytes]);
    const grouped = text.toLowerCase().match(/.{1,4}/g)!.join('-');
    expect([...base32Decode(grouped)]).toEqual([...bytes]);
  });
});
