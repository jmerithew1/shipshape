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
 * delivery actually happens. So the authoritative check runs against the
 * resolved address immediately before the request. Registration keeps a cheap
 * syntactic check purely for fast feedback.
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

function isBlockedIPv6(ip: string): string | null {
  const v = ip.toLowerCase();
  if (v === '::' ) return 'unspecified (::)';
  if (v === '::1') return 'loopback (::1)';
  if (v.startsWith('fe80')) return 'link-local (fe80::/10)';
  if (v.startsWith('fc') || v.startsWith('fd')) return 'unique local (fc00::/7)';
  if (v.startsWith('ff')) return 'multicast (ff00::/8)';
  // IPv4-mapped (::ffff:10.0.0.1) — evaluate the embedded v4 address.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
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
