/**
 * SSRF guard for outbound webhook delivery.
 *
 * THE ATTACK THIS CLOSES. `target_url` is attacker-supplied at subscription
 * time, the deliverer POSTs to it, and up to 500 bytes of the RESPONSE BODY are
 * stored on the delivery row and readable by the subscribing app. That pairing
 * — server-side request plus response read-back — turns Ship into a confused
 * deputy: register subscriptions pointing at internal host:port pairs, trigger
 * one event, then read the delivery log to port-scan and fingerprint the
 * private network. Found by the security review, which demonstrated that a
 * loopback URL was accepted.
 *
 * WHY THE CHECK LIVES AT DELIVERY TIME. Validating at registration alone loses
 * to DNS rebinding: a hostname that resolves to a public address when the
 * subscription is created can resolve to 169.254.169.254 an hour later, when
 * delivery actually happens. So the check runs against the resolved address
 * immediately before the request. Registration keeps a cheap syntactic check
 * purely for fast feedback.
 *
 * RESIDUAL WINDOW (honest limitation, not yet closed). This narrows but does
 * not eliminate rebinding: `fetch` re-resolves the hostname when it connects,
 * so a resolver that answers public to this lookup and internal to the
 * connect a few milliseconds later still wins the race. Fully closing it needs
 * the connection pinned to the address verified here (an undici dispatcher with
 * a fixed `lookup`); that is the documented follow-up. What IS fully closed is
 * every static internal target and every encoding of one — see ipv6ToBytes.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export interface TargetCheck {
  allowed: boolean;
  reason?: string;
  address?: string;
}

/**
 * Ranges that must never receive a webhook. Cloud metadata first — it is the
 * highest-value target and the reason this file exists.
 */
function isBlockedIPv4(ip: string): string | null {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 'unparseable IPv4 address';
  const [a, b] = parts as [number, number, number, number];

  if (a === 169 && b === 254) return 'link-local / cloud metadata (169.254.0.0/16)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 10) return 'private (10.0.0.0/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64.0.0/10)';
  if (a === 0) return 'unspecified (0.0.0.0/8)';
  if (a >= 224) return 'multicast or reserved (224.0.0.0/3)';
  return null;
}

/**
 * Expand any valid IPv6 literal to its 16 bytes.
 *
 * This is the load-bearing correctness fix behind the whole guard: the previous
 * version matched string PREFIXES (`startsWith('fe80')`, a dotted-decimal
 * `::ffff:` regex), which the same address written a different way walks
 * straight past. `::ffff:a9fe:a9fe` IS 169.254.169.254 (cloud metadata) and
 * `::ffff:7f00:1` IS 127.0.0.1, but neither is dotted-decimal, so both were
 * ALLOWED — defeating the one thing this file exists to prevent. `fe80::/10`
 * spans fe80–febf, so `fe90::` and `feb0::` were link-local yet let through.
 * Normalizing to bytes and range-checking removes the entire class of
 * encoding-evasion bugs. Input is always a net.isIPv6-validated literal.
 */
function ipv6ToBytes(ip: string): number[] | null {
  const pct = ip.indexOf('%');
  let s = (pct >= 0 ? ip.slice(0, pct) : ip).toLowerCase();

  // A dotted-decimal IPv4 tail (::ffff:127.0.0.1, ::127.0.0.1) — fold it into
  // two hextets so the rest of the parser only handles hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const p = tail.split('.').map((n) => Number(n));
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = p as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (g: string): number[] | null => {
    if (g === '') return [];
    const out: number[] = [];
    for (const part of g.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;
  let words: number[];
  if (halves.length === 2) {
    const back = parseGroups(halves[1] ?? '');
    if (back === null) return null;
    const gap = 8 - head.length - back.length;
    if (gap < 0) return null;
    words = [...head, ...Array<number>(gap).fill(0), ...back];
  } else {
    words = head;
  }
  if (words.length !== 8) return null;
  const bytes: number[] = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

function isBlockedIPv6(ip: string): string | null {
  const b = ipv6ToBytes(ip);
  if (!b) return 'unparseable IPv6 address';
  const embeddedV4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  const high10Zero = b.slice(0, 10).every((x) => x === 0);

  // ::ffff:a.b.c.d — IPv4-mapped. The address IS that v4; judge it as v4 (a
  // public mapped address stays allowed, a private/loopback one is blocked).
  if (high10Zero && b[10] === 0xff && b[11] === 0xff) return isBlockedIPv4(embeddedV4);

  // ::/96 — :: , ::1 , and the deprecated IPv4-compatible ::a.b.c.d form.
  if (high10Zero && b[10] === 0 && b[11] === 0) {
    if (b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 0) return 'unspecified (::)';
    if (b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 1) return 'loopback (::1)';
    // IPv4-compatible addresses are deprecated (RFC 4291 §2.5.5.1) and never a
    // legitimate webhook target; block, but name the embedded range if internal.
    return isBlockedIPv4(embeddedV4) ?? 'deprecated IPv4-compatible address (::/96)';
  }

  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if ((b[0]! & 0xfe) === 0xfc) return 'unique local (fc00::/7)';
  if (b[0] === 0xff) return 'multicast (ff00::/8)';
  return null;
}

export function isBlockedAddress(ip: string): string | null {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return 'unrecognized address family';
}

/**
 * Resolve the target and refuse anything pointing inside the perimeter.
 *
 * `allowPrivate` exists ONLY for tests, which legitimately deliver to
 * 127.0.0.1 on an ephemeral port. It is never enabled from configuration in a
 * deployed environment — a flag that could be flipped in production would
 * reintroduce exactly the hole this file closes.
 */
export async function checkDeliveryTarget(
  rawUrl: string,
  opts?: { allowPrivate?: boolean; resolver?: typeof lookup }
): Promise<TargetCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'target_url is not an absolute URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { allowed: false, reason: `unsupported protocol ${parsed.protocol}` };
  }
  if (opts?.allowPrivate) return { allowed: true };

  // A literal IP in the URL never reaches DNS, so check it directly.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const blocked = isBlockedAddress(host);
    return blocked
      ? { allowed: false, reason: `target resolves to a blocked range: ${blocked}`, address: host }
      : { allowed: true, address: host };
  }

  try {
    const resolve = opts?.resolver ?? lookup;
    // `all: true` matters: a hostname with several A records must be refused if
    // ANY of them is internal, or an attacker just needs one public decoy.
    const answers = await resolve(host, { all: true });
    if (answers.length === 0) return { allowed: false, reason: `${host} did not resolve` };
    for (const a of answers) {
      const blocked = isBlockedAddress(a.address);
      if (blocked) {
        return {
          allowed: false,
          reason: `target resolves to a blocked range: ${blocked}`,
          address: a.address,
        };
      }
    }
    return { allowed: true, address: answers[0]!.address };
  } catch (err) {
    return {
      allowed: false,
      reason: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
