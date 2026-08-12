/**
 * Command behaviour against a fake SDK client. No network, no filesystem.
 */
import { describe, expect, it } from 'vitest';
import type { ShipClient, ShipDocument, Page, ShipWebhook } from '@ship/sdk';
import { docsCreate, docsGet, docsList } from './commands/docs.js';
import { absoluteVerifyUrl, loginCommand } from './commands/login.js';
import { webhooksCreate, webhooksList } from './commands/webhooks.js';

function doc(id: string, title: string): ShipDocument {
  return {
    id,
    title,
    document_type: 'wiki',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
  };
}

/** A documents client that pages, so `ls` is exercised across a cursor. */
function fakeDocuments(pages: ShipDocument[][]): Pick<ShipClient, 'documents'>['documents'] {
  const list = async (params?: { cursor?: string }): Promise<Page<ShipDocument>> => {
    const index = params?.cursor === undefined ? 0 : Number(params.cursor);
    const data = pages[index] ?? [];
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return { data, next_cursor: next };
  };

  return {
    list,
    iterate(params?: { cursor?: string }): AsyncGenerator<ShipDocument> {
      return (async function* () {
        let cursor = params?.cursor;
        for (;;) {
          const page = await list(cursor === undefined ? {} : { cursor });
          for (const item of page.data) yield item;
          if (page.next_cursor === null) return;
          cursor = page.next_cursor;
        }
      })();
    },
    async get(id: string): Promise<ShipDocument> {
      return doc(id, 'Fetched');
    },
    async create(input: { title: string }): Promise<ShipDocument> {
      return doc('doc_created_1', input.title);
    },
  } as unknown as Pick<ShipClient, 'documents'>['documents'];
}

describe('docs ls', () => {
  it('walks every page without the user ever seeing a cursor', async () => {
    const lines: string[] = [];
    await docsList(
      { documents: fakeDocuments([[doc('a', 'One'), doc('b', 'Two')], [doc('c', 'Three')]]) },
      {},
      { write: (line) => lines.push(line) }
    );
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('Three');
    expect(lines.join('\n')).not.toContain('cursor');
  });

  it('stops at --limit instead of draining the whole workspace', async () => {
    const lines: string[] = [];
    await docsList(
      { documents: fakeDocuments([[doc('a', 'One'), doc('b', 'Two')], [doc('c', 'Three')]]) },
      { limit: 2 },
      { write: (line) => lines.push(line) }
    );
    expect(lines).toHaveLength(2);
  });

  it('says so on an empty workspace rather than printing nothing', async () => {
    const lines: string[] = [];
    await docsList({ documents: fakeDocuments([[]]) }, {}, { write: (line) => lines.push(line) });
    expect(lines).toEqual(['no documents']);
  });
});

describe('docs get / create', () => {
  it('renders a detail block', async () => {
    const lines: string[] = [];
    await docsGet({ documents: fakeDocuments([[]]) }, 'doc_7', {
      write: (line) => lines.push(line),
    });
    expect(lines.join('\n')).toContain('doc_7');
  });

  it('prints the created id alone on its own line, for `$(...)`', async () => {
    const lines: string[] = [];
    await docsCreate(
      { documents: fakeDocuments([[]]) },
      { title: 'Drill doc' },
      { write: (line) => lines.push(line) }
    );
    expect(lines).toEqual(['doc_created_1']);
  });
});

describe('login', () => {
  it('turns a relative verification_uri into something a user can actually open', () => {
    // The live server returns `/device?user_code=…`. A relative path is
    // useless on the second machine, which is the whole premise of the grant.
    expect(absoluteVerifyUrl('/device?user_code=ABCD-EFGH', 'https://ship.example')).toBe(
      'https://ship.example/device?user_code=ABCD-EFGH'
    );
    expect(absoluteVerifyUrl('https://elsewhere/d', 'https://ship.example')).toBe(
      'https://elsewhere/d'
    );
  });

  it('prints the user code, the URL, and then `Logged in as <email>`', async () => {
    const lines: string[] = [];

    await loginCommand(
      {},
      {
        write: (line) => lines.push(line),
        deviceLogin: (async (options: {
          onUserCode: (code: string, url: string) => void;
        }) => {
          options.onUserCode('WDJB-MJHT', 'https://ship.example/device');
          return { async me() { return { email: 'demo@ship.local' }; } };
        }) as unknown as typeof ShipClient.deviceLogin,
      }
    );

    const output = lines.join('\n');
    expect(output).toContain('WDJB-MJHT');
    expect(output).toContain('https://ship.example/device');
    expect(lines.some((l) => l === 'Logged in as demo@ship.local')).toBe(true);
    // The success line must come after the code — a user is told to wait
    // before being told they are done.
    expect(output.indexOf('WDJB-MJHT')).toBeLessThan(output.indexOf('Logged in as'));
  });
});

describe('webhooks', () => {
  it('shows the signing secret once, with the warning that it is the only time', async () => {
    const lines: string[] = [];
    const client = {
      webhooks: {
        async create(): Promise<ShipWebhook> {
          return {
            id: 'sub_1',
            event: 'document.created',
            target_url: 'https://example.com/hook',
            created_at: '2026-08-12T00:00:00.000Z',
            secret: 'whsec_abc123',
          };
        },
      },
    } as unknown as Pick<ShipClient, 'webhooks'>;

    await webhooksCreate(
      client,
      { event: 'document.created', url: 'https://example.com/hook' },
      { write: (line) => lines.push(line) }
    );

    const output = lines.join('\n');
    expect(output).toContain('whsec_abc123');
    expect(output).toContain('only time');
    expect(output).toContain('ship webhooks tail');
  });

  it('says so when there are no subscriptions', async () => {
    const lines: string[] = [];
    const client = {
      webhooks: {
        async list(): Promise<Page<ShipWebhook>> {
          return { data: [], next_cursor: null };
        },
      },
    } as unknown as Pick<ShipClient, 'webhooks'>;
    await webhooksList(client, { write: (line) => lines.push(line) });
    expect(lines).toEqual(['no webhook subscriptions']);
  });
});
