/**
 * Open-redirect guard for the CAIA callback's returnTo (security scan, CWE-601).
 * Pure — no server, no DB.
 */
import { describe, it, expect } from 'vitest';
import { isValidReturnTo } from './caia-auth.js';

describe('isValidReturnTo', () => {
  it('accepts genuine same-origin relative paths', () => {
    expect(isValidReturnTo('/')).toBe(true);
    expect(isValidReturnTo('/dashboard')).toBe(true);
    expect(isValidReturnTo('/docs/123?tab=history#top')).toBe(true);
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(isValidReturnTo('//evil.com')).toBe(false);
    expect(isValidReturnTo('https://evil.com')).toBe(false);
    expect(isValidReturnTo('http://evil.com')).toBe(false);
  });

  it('rejects the backslash-folding bypass', () => {
    // Browsers fold '\' to '/', so these resolve off-origin despite passing the
    // old startsWith('/') && !startsWith('//') check.
    expect(isValidReturnTo('/\\evil.com')).toBe(false);
    expect(isValidReturnTo('/\\/evil.com')).toBe(false);
    expect(isValidReturnTo('\\evil.com')).toBe(false);
  });

  it('rejects non-path junk', () => {
    expect(isValidReturnTo('javascript:alert(1)')).toBe(false);
    expect(isValidReturnTo('dashboard')).toBe(false);
    expect(isValidReturnTo('')).toBe(false);
  });
});
