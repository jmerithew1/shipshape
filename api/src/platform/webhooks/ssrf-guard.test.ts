/**
 * SSRF-guard unit tests. Pure — no database, no network (a fake resolver is
 * injected). The IPv6 block is the reason this file exists: the guard shipped
 * with string-prefix matching that let every non-dotted encoding of an internal
 * address through, so each encoding of loopback / metadata / link-local has its
 * own assertion here to keep that regression closed.
 */
import { describe, expect, it } from 'vitest';
import { isBlockedAddress, checkDeliveryTarget } from './ssrf-guard.js';

describe('isBlockedAddress — IPv4', () => {
  it('blocks the ranges that must never receive a webhook', () => {
    expect(isBlockedAddress('169.254.169.254')).toMatch(/metadata/);
    expect(isBlockedAddress('127.0.0.1')).toMatch(/loopback/);
    expect(isBlockedAddress('10.0.0.1')).toMatch(/private/);
    expect(isBlockedAddress('172.16.5.5')).toMatch(/private/);
    expect(isBlockedAddress('192.168.1.1')).toMatch(/private/);
    expect(isBlockedAddress('100.64.0.1')).toMatch(/NAT/);
    expect(isBlockedAddress('0.0.0.0')).toMatch(/unspecified/);
    expect(isBlockedAddress('224.0.0.1')).toMatch(/multicast/);
  });

  it('allows ordinary public addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBeNull();
    expect(isBlockedAddress('93.184.216.34')).toBeNull();
    expect(isBlockedAddress('172.15.0.1')).toBeNull(); // just below the private block
    expect(isBlockedAddress('172.32.0.1')).toBeNull(); // just above it
  });
});

describe('isBlockedAddress — IPv6 encoding evasion (regression: N1)', () => {
  it('blocks loopback and metadata in the hex-compressed IPv4-mapped form', () => {
    // ::ffff:7f00:1 IS 127.0.0.1; ::ffff:a9fe:a9fe IS 169.254.169.254.
    // The old prefix matcher let both through — the bug this test locks down.
    expect(isBlockedAddress('::ffff:7f00:1')).toMatch(/loopback/);
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toMatch(/metadata/);
    expect(isBlockedAddress('::ffff:a00:1')).toMatch(/private/); // 10.0.0.1
  });

  it('blocks the same addresses in the dotted IPv4-mapped form', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toMatch(/loopback/);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toMatch(/metadata/);
  });

  it('blocks deprecated IPv4-compatible addresses', () => {
    expect(isBlockedAddress('::127.0.0.1')).toMatch(/loopback/);
    expect(isBlockedAddress('::7f00:1')).toMatch(/loopback/);
  });

  it('blocks loopback and unspecified literals', () => {
    expect(isBlockedAddress('::1')).toMatch(/loopback/);
    expect(isBlockedAddress('::')).toMatch(/unspecified/);
  });

  it('masks link-local across the whole fe80::/10 span, not just the fe80 prefix', () => {
    expect(isBlockedAddress('fe80::1')).toMatch(/link-local/);
    expect(isBlockedAddress('fe90::1')).toMatch(/link-local/);
    expect(isBlockedAddress('fea0::1')).toMatch(/link-local/);
    expect(isBlockedAddress('feb0::1')).toMatch(/link-local/);
    // fec0:: is outside fe80::/10 (it is the deprecated site-local range) —
    // it must NOT be caught by the link-local mask.
    expect(isBlockedAddress('fec0::1')).toBeNull();
  });

  it('blocks unique-local and multicast', () => {
    expect(isBlockedAddress('fc00::1')).toMatch(/unique local/);
    expect(isBlockedAddress('fd12:3456::1')).toMatch(/unique local/);
    expect(isBlockedAddress('ff02::1')).toMatch(/multicast/);
  });

  it('allows a genuine public IPv6 address', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBeNull(); // Cloudflare DNS
    // A public IPv4 wrapped in the mapped form stays allowed.
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBeNull();
    expect(isBlockedAddress('::ffff:808:808')).toBeNull();
  });
});

describe('checkDeliveryTarget', () => {
  const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

  it('refuses a literal metadata address written in the mapped IPv6 form', async () => {
    const r = await checkDeliveryTarget('http://[::ffff:a9fe:a9fe]/latest/meta-data/');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/blocked range/);
  });

  it('refuses a hostname whose ANY resolved address is internal', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    const r = await checkDeliveryTarget('https://rebind.example.com/hook', {
      resolver: mixed as never,
    });
    expect(r.allowed).toBe(false);
    expect(r.address).toBe('169.254.169.254');
  });

  it('allows a public host and reports the resolved address', async () => {
    const r = await checkDeliveryTarget('https://api.example.com/hook', {
      resolver: publicResolver as never,
    });
    expect(r.allowed).toBe(true);
    expect(r.address).toBe('93.184.216.34');
  });

  it('rejects non-http(s) schemes outright', async () => {
    expect((await checkDeliveryTarget('file:///etc/passwd')).allowed).toBe(false);
    expect((await checkDeliveryTarget('gopher://x/')).allowed).toBe(false);
  });
});
