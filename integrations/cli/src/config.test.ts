/**
 * Configuration precedence: flag > environment > default, everywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  credentialsPath,
  DEFAULT_BASE_URL,
  DEFAULT_CLIENT_ID,
  resolveBaseUrl,
  resolveClientId,
  resolveWebhookSecret,
} from './config.js';

describe('resolveBaseUrl', () => {
  it('prefers the flag', () => {
    expect(resolveBaseUrl('http://localhost:3000', { SHIP_BASE_URL: 'https://env' })).toBe(
      'http://localhost:3000'
    );
  });
  it('falls back to the environment, then to the default', () => {
    expect(resolveBaseUrl(undefined, { SHIP_BASE_URL: 'https://env' })).toBe('https://env');
    expect(resolveBaseUrl(undefined, {})).toBe(DEFAULT_BASE_URL);
  });
  it('treats an empty string as unset rather than as an origin', () => {
    expect(resolveBaseUrl('', { SHIP_BASE_URL: '' })).toBe(DEFAULT_BASE_URL);
  });
});

describe('resolveClientId', () => {
  it('follows the same precedence', () => {
    expect(resolveClientId('flag', { SHIP_CLIENT_ID: 'env' })).toBe('flag');
    expect(resolveClientId(undefined, { SHIP_CLIENT_ID: 'env' })).toBe('env');
    expect(resolveClientId(undefined, {})).toBe(DEFAULT_CLIENT_ID);
  });
});

describe('resolveWebhookSecret', () => {
  it('has no default — a missing secret must stay missing, not become empty', () => {
    expect(resolveWebhookSecret(undefined, {})).toBeUndefined();
    expect(resolveWebhookSecret('', {})).toBeUndefined();
    expect(resolveWebhookSecret(undefined, { SHIP_WEBHOOK_SECRET: 'whsec_1' })).toBe('whsec_1');
    expect(resolveWebhookSecret('flag', { SHIP_WEBHOOK_SECRET: 'whsec_1' })).toBe('flag');
  });
});

describe('credentialsPath', () => {
  it('is ~/.ship/credentials.json', () => {
    const path = credentialsPath('/home/dev');
    expect(path.replace(/\\/g, '/')).toBe('/home/dev/.ship/credentials.json');
  });
});
