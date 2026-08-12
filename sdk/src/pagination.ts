/**
 * Cursor pagination, hidden.
 *
 * The API pages with opaque cursors: every list response carries
 * `next_cursor`, and the caller is expected to feed it back. That is a loop
 * every consumer would otherwise write — and write subtly wrong, because the
 * two termination conditions (`next_cursor === null` and an empty page) are
 * easy to conflate.
 *
 * `paginate` writes it once. Consumers get `for await (const doc of
 * client.documents.iterate())` and never see a cursor at all.
 */

export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
}

export type FetchPage<T> = (cursor?: string) => Promise<CursorPage<T>>;

export async function* paginate<T>(fetchPage: FetchPage<T>): AsyncGenerator<T> {
  let cursor: string | undefined;

  for (;;) {
    const page = await fetchPage(cursor);

    for (const item of page.data) {
      yield item;
    }

    const next = page.next_cursor;
    // `null` is the server's end-of-list marker. An empty string would be a
    // bug on the wire, so it is treated as the end too rather than looping
    // forever on the same page.
    if (next === null || next === undefined || next === '') return;

    // Defence against a server that echoes the cursor it was given: without
    // this the iterator would spin on one page indefinitely.
    if (next === cursor) return;

    cursor = next;
  }
}

/** Drain an async iterator into an array. Convenience for small result sets. */
export async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) {
    items.push(item);
  }
  return items;
}
