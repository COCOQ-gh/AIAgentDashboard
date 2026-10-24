import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost, isAllowedOrigin } from '../src/host-check.mjs';

test('Host は loopback の hostname だけを許可し、ポートと大文字小文字を無視する', () => {
  for (const host of ['127.0.0.1:4317', 'localhost', 'LOCALHOST', '[::1]:4317', '::1']) {
    assert.equal(isAllowedHost(host, '127.0.0.1'), true, host);
  }
  for (const host of ['evil.example', 'evil.example:4317', '127.0.0.1.evil.example', undefined]) {
    assert.equal(isAllowedHost(host, '127.0.0.1'), false, String(host));
  }
});

test('独自 bind host はその HOST のときだけ許可し、wildcard は hostname に追加しない', () => {
  assert.equal(isAllowedHost('mybox.local:4317', 'mybox.local'), true);
  assert.equal(isAllowedHost('MYBOX.LOCAL', 'mybox.local'), true);
  assert.equal(isAllowedHost('mybox.local', '127.0.0.1'), false);
  assert.equal(isAllowedHost('0.0.0.0:4317', '0.0.0.0'), false);
  assert.equal(isAllowedHost('[::]:4317', '::'), false);
});

test('Origin は未指定を許可し、許可 hostname 以外と null を拒否する', () => {
  assert.equal(isAllowedOrigin(undefined, '127.0.0.1'), true);
  assert.equal(isAllowedOrigin('http://localhost:4317', '127.0.0.1'), true);
  assert.equal(isAllowedOrigin('http://evil.example', '127.0.0.1'), false);
  assert.equal(isAllowedOrigin('null', '127.0.0.1'), false);
  assert.equal(isAllowedOrigin('', '127.0.0.1'), false);
  assert.equal(isAllowedOrigin('http://mybox.local:4317', 'mybox.local'), true);
  assert.equal(isAllowedOrigin('http://mybox.local:4317', '127.0.0.1'), false);
});
