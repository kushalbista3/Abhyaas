import test from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, startupBanner } from '../src/lan.js';

test('lanAddresses keeps reachable IPv4, private ranges first', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun3: [{ family: 'IPv4', address: '100.64.1.2', internal: false }],
    en0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.5', internal: false },
    ],
    en5: [{ family: 'IPv4', address: '169.254.10.1', internal: false }],
    bridge0: [{ family: 4, address: '10.0.0.7', internal: false }],
  };
  assert.deepEqual(lanAddresses(ifaces), [
    { name: 'en0', address: '192.168.1.5' },
    { name: 'bridge0', address: '10.0.0.7' },
    { name: 'utun3', address: '100.64.1.2' },
  ]);
  assert.deepEqual(lanAddresses({}), []);
});

test('startupBanner prints the exact gateway command for each address', () => {
  const lines = startupBanner(3001, [{ name: 'en0', address: '192.168.1.5' }]);
  assert.ok(lines.includes('LAN: http://192.168.1.5:3001 (en0)'));
  assert.ok(lines.includes('  LAPTOP_URL=http://192.168.1.5:3001 node gateway.mjs'));
  assert.match(startupBanner(3001, []).join('\n'), /No LAN address/);
});
