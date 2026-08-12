import { describe, expect, it, vi } from 'vitest';
import { collect, paginate, type CursorPage } from './pagination.js';

interface Row {
  id: string;
}

function pagesOf(...pages: Array<CursorPage<Row>>) {
  const seen: Array<string | undefined> = [];
  const fetchPage = vi.fn(async (cursor?: string): Promise<CursorPage<Row>> => {
    seen.push(cursor);
    const index = cursor === undefined ? 0 : Number(cursor.replace('cursor_', ''));
    const page = pages[index];
    if (!page) throw new Error(`test asked for a page that does not exist: ${String(cursor)}`);
    return page;
  });
  return { fetchPage, seen };
}

describe('paginate', () => {
  it('walks three pages transparently and stops when next_cursor is null', async () => {
    const { fetchPage, seen } = pagesOf(
      { data: [{ id: 'a' }, { id: 'b' }], next_cursor: 'cursor_1' },
      { data: [{ id: 'c' }, { id: 'd' }], next_cursor: 'cursor_2' },
      { data: [{ id: 'e' }], next_cursor: null }
    );

    const ids: string[] = [];
    for await (const row of paginate(fetchPage)) {
      // The consumer's loop body is the whole point: it sees rows, never a
      // cursor, and never a page boundary.
      ids.push(row.id);
    }

    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    // First call is cursorless; each later call replays the server's cursor.
    expect(seen).toEqual([undefined, 'cursor_1', 'cursor_2']);
  });

  it('yields nothing for an empty first page', async () => {
    const fetchPage = vi.fn(async () => ({ data: [] as Row[], next_cursor: null }));
    expect(await collect(paginate(fetchPage))).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps going through an empty middle page', async () => {
    const { fetchPage } = pagesOf(
      { data: [{ id: 'a' }], next_cursor: 'cursor_1' },
      { data: [], next_cursor: 'cursor_2' },
      { data: [{ id: 'b' }], next_cursor: null }
    );
    expect((await collect(paginate(fetchPage))).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('stops rather than spinning when a server echoes the same cursor back', async () => {
    const fetchPage = vi.fn(async (cursor?: string): Promise<CursorPage<Row>> => {
      return { data: [{ id: cursor ?? 'first' }], next_cursor: 'stuck' };
    });
    const rows = await collect(paginate(fetchPage));
    expect(rows).toEqual([{ id: 'first' }, { id: 'stuck' }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('is lazy — abandoning the loop early stops fetching', async () => {
    const { fetchPage } = pagesOf(
      { data: [{ id: 'a' }, { id: 'b' }], next_cursor: 'cursor_1' },
      { data: [{ id: 'c' }], next_cursor: 'cursor_2' },
      { data: [{ id: 'd' }], next_cursor: null }
    );

    const ids: string[] = [];
    for await (const row of paginate(fetchPage)) {
      ids.push(row.id);
      if (ids.length === 2) break;
    }

    expect(ids).toEqual(['a', 'b']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure from the underlying page fetch', async () => {
    const fetchPage = vi.fn(async (): Promise<CursorPage<Row>> => {
      throw new Error('boom');
    });
    await expect(collect(paginate(fetchPage))).rejects.toThrow('boom');
  });
});
