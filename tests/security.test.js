import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSafeUrl } from '../src/urlGuard.js';
import shouldCompress from '../src/shouldCompress.js';

describe('🛡️ urlGuard - SSRF Protection', () => {
  test('should block localhost and loopback', () => {
    assert.equal(parseSafeUrl('http://localhost/secret'), null);
    assert.equal(parseSafeUrl('http://127.0.0.1/secret'), null);
    assert.equal(parseSafeUrl('http://[::1]/secret'), null);
  });

  test('should block private network IPs', () => {
    assert.equal(parseSafeUrl('http://192.168.1.1/'), null);
    assert.equal(parseSafeUrl('http://10.0.0.5/'), null);
    assert.equal(parseSafeUrl('http://172.16.0.1/'), null);
  });

  test('should block internal TLDs', () => {
    assert.equal(parseSafeUrl('http://server.local/'), null);
    assert.equal(parseSafeUrl('http://db.internal/'), null);
  });

  test('should allow public domains and IPs', () => {
    assert.notEqual(parseSafeUrl('https://example.com/image.jpg'), null);
    assert.notEqual(parseSafeUrl('https://8.8.8.8/'), null);
  });
  
  test('should strip IPv6 brackets safely', () => {
    const url = parseSafeUrl('http://[2001:4860:4860::8888]/');
    assert.notEqual(url, null);
    assert.equal(url.hostname, '[2001:4860:4860::8888]'); // Node URL retains brackets
  });
});

describe('🧠 shouldCompress - Memory & Logic Guards', () => {
  test('should reject files > 14MB to protect serverless memory', () => {
    const largeBuffer = Buffer.alloc(15 * 1024 * 1024); // 15MB
    const req = { opts: { originType: 'image/jpeg' } };
    assert.equal(shouldCompress(req, largeBuffer), false);
  });

  test('should accept valid images < 14MB', () => {
    const smallBuffer = Buffer.alloc(1024); // 1KB
    const req = { opts: { originType: 'image/jpeg' } };
    assert.equal(shouldCompress(req, smallBuffer), true);
  });
  
  test('should reject non-image MIME types', () => {
    const buffer = Buffer.alloc(1024);
    const req = { opts: { originType: 'application/pdf' } };
    assert.equal(shouldCompress(req, buffer), false);
  });

  test('should reject empty buffers', () => {
    const buffer = Buffer.alloc(0);
    const req = { opts: { originType: 'image/jpeg' } };
    assert.equal(shouldCompress(req, buffer), false);
  });
});
