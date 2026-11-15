import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { dbKeys } from '../src/core/db';
import { BLOB_PART, delBlob, exportBackup, getBlob, importBackup, lock, putBlob, setupVault, unlock } from '../src/core/store';

const PW = 'blue-Tiger-2026!';
const pattern = (n: number) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + (i >> 9)) & 255; return u; };
const same = (a: ArrayBuffer | null, b: Uint8Array) => !!a && a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe('encrypted file storage', () => {
  it('stores a large upload in parts and returns it byte for byte, also after backup and restore', async () => {
    await setupVault(PW);
    const big = pattern(BLOB_PART * 2 + 12345); // three parts
    const small = pattern(5000);
    const seen: number[] = [];
    const bigId = await putBlob(big, undefined, (p) => seen.push(p));
    const smallId = await putBlob(small);
    expect(seen.at(-1)).toBe(1);
    expect((await dbKeys('blobs')).filter((k) => k.startsWith(bigId + '#'))).toHaveLength(3);
    expect(same(await getBlob(bigId), big)).toBe(true);
    expect(same(await getBlob(smallId), small)).toBe(true);

    const backup = await exportBackup(true);
    expect(await backup.text()).not.toContain('marketing-secret');
    await delBlob(bigId);
    expect(await getBlob(bigId)).toBeNull();
    expect((await dbKeys('blobs')).some((k) => k.startsWith(bigId))).toBe(false);

    expect(await importBackup(backup)).toBeNull();
    expect(await unlock({ password: 'wrong password 1' })).toMatch(/Wrong password/);
    expect(await unlock({ password: PW })).toBeNull();
    expect(same(await getBlob(bigId), big)).toBe(true);
    expect(same(await getBlob(smallId), small)).toBe(true);
    lock();
    await expect(getBlob(bigId)).rejects.toThrow(/locked/);
  }, 60000);
});
