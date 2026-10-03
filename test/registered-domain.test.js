import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeRequest,
  createRegisteredDomainResolver,
  getRegisteredDomain
} from '../background/request-analyzer.js';

test('bundled Public Suffix List resolves ICANN and private suffixes', () => {
  assert.equal(getRegisteredDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(getRegisteredDomain('a.github.io'), 'a.github.io');
  assert.equal(getRegisteredDomain('b.github.io'), 'b.github.io');
  assert.notEqual(getRegisteredDomain('a.github.io'), getRegisteredDomain('b.github.io'));

  const tenantRequest = analyzeRequest({
    url: 'https://a.github.io/resource',
    initiator: 'https://b.github.io/'
  });
  assert.equal(tenantRequest.isThirdParty, true);
});

test('hostname normalization handles uppercase and trailing dots', () => {
  assert.equal(getRegisteredDomain('WWW.EXAMPLE.CO.UK...'), 'example.co.uk');
});

test('IPs, localhost, empty strings, and malformed hostnames return null', () => {
  for (const hostname of [
    '',
    '   ',
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '192.168.1.4',
    '::1',
    '[2001:db8::1]',
    'example..com',
    'bad host.example',
    'http://example.com',
    '-bad.example'
  ]) {
    assert.equal(getRegisteredDomain(hostname), null, hostname);
  }
});

test('native publicSuffix API is preferred when it returns a valid domain', () => {
  const calls = [];
  const resolver = createRegisteredDomainResolver({
    getNativeApi: () => ({
      getDomain(hostname, options) {
        calls.push([hostname, options]);
        return 'example.native';
      }
    }),
    fallbackGetDomain: () => {
      throw new Error('fallback should not run');
    }
  });

  assert.equal(resolver('WWW.EXAMPLE.CO.UK.'), 'example.native');
  assert.deepEqual(calls, [[
    'www.example.co.uk',
    {
      allowIPAddress: false,
      allowPlainSuffix: false,
      allowUnknownSuffix: false,
      encoding: 'punycode'
    }
  ]]);
});

test('fallback receives private suffix support when native API is missing or fails', () => {
  const fallbackCalls = [];
  const fallbackGetDomain = (hostname, options) => {
    fallbackCalls.push([hostname, options]);
    return hostname === 'a.github.io' ? 'a.github.io' : null;
  };
  const missingNative = createRegisteredDomainResolver({
    getNativeApi: () => undefined,
    fallbackGetDomain
  });
  const brokenNative = createRegisteredDomainResolver({
    getNativeApi: () => ({ getDomain() { throw new Error('native API failed'); } }),
    fallbackGetDomain
  });

  assert.equal(missingNative('a.github.io'), 'a.github.io');
  assert.equal(brokenNative('a.github.io'), 'a.github.io');
  assert.deepEqual(fallbackCalls, [
    ['a.github.io', { allowPrivateDomains: true }],
    ['a.github.io', { allowPrivateDomains: true }]
  ]);
});