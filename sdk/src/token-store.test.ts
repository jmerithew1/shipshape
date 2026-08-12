import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileTokenStore, LocalStorageTokenStore, MemoryTokenStore } from './token-store.js';
import type { Tokens } from './types.js';

const TOKENS: Tokens = {
  access_token: 'tok_1',
  refresh_token: 'ref_1',
  expires_at: 1_786_000_000_000,
};

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ship-sdk-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'tokens.json');
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MemoryTokenStore', () => {
  it('round-trips and clears', async () => {
    const store = new MemoryTokenStore();
    expect(await store.get()).toBeNull();
    await store.set(TOKENS);
    expect(await store.get()).toEqual(TOKENS);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('can be seeded at construction', async () => {
    expect(await new MemoryTokenStore(TOKENS).get()).toEqual(TOKENS);
  });
});

describe('FileTokenStore', () => {
  it('creates missing directories, round-trips, and clears', async () => {
    const path = await tempFile();
    const store = new FileTokenStore(path);

    expect(await store.get()).toBeNull();
    await store.set(TOKENS);
    expect(await store.get()).toEqual(TOKENS);

    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('writes owner-only permissions where the platform has them', async () => {
    const path = await tempFile();
    await new FileTokenStore(path).set(TOKENS);

    const mode = (await stat(path)).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows has no POSIX modes — Node always reports 0o666 and chmod is a
      // no-op. Access there is governed by the ACL the file inherits, so the
      // only assertion that means anything is that set() did not throw.
      expect(mode).toBeGreaterThan(0);
      return;
    }
    expect(mode).toBe(0o600);
    // No group or world access to a bearer credential.
    expect(mode & 0o077).toBe(0);
  });

  it('treats a corrupt file as logged-out rather than throwing', async () => {
    const path = await tempFile();
    const store = new FileTokenStore(path);
    await store.set(TOKENS);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json', 'utf8');

    await expect(store.get()).resolves.toBeNull();
  });

  it('rejects a well-formed file that carries no access_token', async () => {
    const path = await tempFile();
    const store = new FileTokenStore(path);
    await store.set(TOKENS);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ refresh_token: 'orphan' }), 'utf8');

    await expect(store.get()).resolves.toBeNull();
    expect(await readFile(path, 'utf8')).toContain('orphan');
  });
});

describe('LocalStorageTokenStore', () => {
  it('degrades to logged-out when there is no localStorage (Node)', async () => {
    const store = new LocalStorageTokenStore();
    await expect(store.get()).resolves.toBeNull();
    // Must not throw just because the DOM global is absent.
    await expect(store.set(TOKENS)).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('uses localStorage when one exists', async () => {
    const backing = new Map<string, string>();
    const scope = globalThis as { localStorage?: unknown };
    scope.localStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, value),
      removeItem: (key: string) => backing.delete(key),
    };

    try {
      const store = new LocalStorageTokenStore('ship.test.tokens');
      expect(await store.get()).toBeNull();
      await store.set(TOKENS);
      expect(backing.has('ship.test.tokens')).toBe(true);
      expect(await store.get()).toEqual(TOKENS);
      await store.clear();
      expect(await store.get()).toBeNull();
    } finally {
      delete scope.localStorage;
    }
  });
});
