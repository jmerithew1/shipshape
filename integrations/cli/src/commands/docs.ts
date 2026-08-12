/**
 * `ship docs ls | get | create`
 *
 * `ls` drives `documents.iterate()`, the SDK's async generator, so the user
 * never sees a cursor. That is the whole argument for the SDK owning
 * pagination: the CLI is a consumer like any other and it contains no paging
 * logic at all.
 */
import type { CreateDocumentInput, ShipClient } from '@ship/sdk';
import { formatDocumentDetail, formatDocumentRow } from '../output.js';

export interface DocsDeps {
  write: (line: string) => void;
}

export interface ListOptions {
  limit?: number | undefined;
  type?: string | undefined;
  state?: string | undefined;
}

export async function docsList(
  client: Pick<ShipClient, 'documents'>,
  options: ListOptions,
  deps: DocsDeps
): Promise<void> {
  const params: Parameters<ShipClient['documents']['iterate']>[0] = {};
  if (options.type !== undefined) params.document_type = options.type;
  if (options.state !== undefined) params.state = options.state;

  let count = 0;
  const max = options.limit;
  for await (const doc of client.documents.iterate(params)) {
    deps.write(formatDocumentRow(doc));
    count += 1;
    if (max !== undefined && count >= max) break;
  }
  if (count === 0) deps.write('no documents');
}

export async function docsGet(
  client: Pick<ShipClient, 'documents'>,
  id: string,
  deps: DocsDeps
): Promise<void> {
  const doc = await client.documents.get(id);
  deps.write(formatDocumentDetail(doc));
}

export async function docsCreate(
  client: Pick<ShipClient, 'documents'>,
  options: { title: string; type?: string | undefined; content?: string | undefined },
  deps: DocsDeps
): Promise<void> {
  const input: CreateDocumentInput = {
    title: options.title,
    document_type: options.type ?? 'wiki',
  };
  if (options.content !== undefined) input.content = options.content;
  const doc = await client.documents.create(input);
  // The id alone on its own line, so `ID=$(ship docs create --title x | tail -1)`
  // works without a JSON parser.
  deps.write(doc.id);
}
