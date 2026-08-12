/**
 * Where the SDK keeps OAuth tokens.
 *
 * The interface is three async methods and nothing else, which is what makes
 * the three shipped implementations interchangeable and a consumer's own
 * (keychain, Vault, encrypted DB row) a drop-in. `get()` returning `null` —
 * rather than throwing — is the "not logged in yet" signal; a store that
 * cannot read its backing medium throws, and the SDK surfaces that as
 * `kind: 'auth'`.
 *
 * Everything is async even where it need not be (MemoryTokenStore) so that
 * swapping a store never changes a call site.
 */
import type { Tokens } from './types.js';

export interface ITokenStore {
  get(): Promise<Tokens | null>;
  set(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

/** Process-lifetime storage. The default when no store is supplied. */
export class MemoryTokenStore implements ITokenStore {
  private tokens: Tokens | null;

  constructor(initial: Tokens | null = null) {
    this.tokens = initial;
  }

  async get(): Promise<Tokens | null> {
    return this.tokens;
  }

  async set(tokens: Tokens): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}

/**
 * JSON file on disk — what a CLI wants, so `ship login` survives the shell
 * exiting.
 *
 * The file is written 0600 (owner read/write only) because it holds a bearer
 * credential. `chmod` is best-effort: on Windows it is a no-op and on some
 * mounted filesystems it fails outright, and neither is a reason to fail the
 * login. The import of node:fs is dynamic so that a browser bundler tree-
 * shakes this class away instead of choking on a Node builtin.
 */
export class FileTokenStore implements ITokenStore {
  constructor(private readonly path: string) {}

  private async fs(): Promise<typeof import('node:fs/promises')> {
    return import('node:fs/promises');
  }

  async get(): Promise<Tokens | null> {
    const fs = await this.fs();
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      // Missing file is "not logged in", not an error.
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const tokens = parsed as Tokens;
      return typeof tokens.access_token === 'string' ? tokens : null;
    } catch {
      // A truncated or hand-edited file is treated as logged-out rather than
      // wedging every subsequent call.
      return null;
    }
  }

  async set(tokens: Tokens): Promise<void> {
    const fs = await this.fs();
    const dir = this.path.replace(/[\\/][^\\/]*$/, '');
    if (dir && dir !== this.path) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(this.path, `${JSON.stringify(tokens, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      // writeFile's `mode` only applies when it creates the file; chmod fixes
      // permissions on an existing file too.
      await fs.chmod(this.path, 0o600);
    } catch {
      // Best effort — Windows and some network mounts have no POSIX modes.
    }
  }

  async clear(): Promise<void> {
    const fs = await this.fs();
    try {
      await fs.rm(this.path, { force: true });
    } catch {
      // Already gone, or not ours to delete.
    }
  }
}

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Browser storage, for the SPA demo (Authorization Code + PKCE).
 *
 * Guarded on `typeof localStorage` so that importing the barrel in Node —
 * which every CLI and server integration does — never touches a DOM global.
 * When there is no localStorage the store degrades to a no-op that reports
 * "logged out" rather than throwing at import time.
 */
export class LocalStorageTokenStore implements ITokenStore {
  constructor(private readonly key: string = 'ship.tokens') {}

  private storage(): WebStorageLike | null {
    const scope = globalThis as { localStorage?: WebStorageLike };
    if (typeof scope.localStorage === 'undefined' || scope.localStorage === null) return null;
    return scope.localStorage;
  }

  async get(): Promise<Tokens | null> {
    const storage = this.storage();
    if (!storage) return null;
    const raw = storage.getItem(this.key);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const tokens = parsed as Tokens;
      return typeof tokens.access_token === 'string' ? tokens : null;
    } catch {
      return null;
    }
  }

  async set(tokens: Tokens): Promise<void> {
    this.storage()?.setItem(this.key, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    this.storage()?.removeItem(this.key);
  }
}
