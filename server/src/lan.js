// What the teacher needs to point the gateway phone at this laptop: the
// laptop's LAN addresses and the exact command to run in Termux.
import os from 'node:os';

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

// Non-internal IPv4 addresses, private ranges first. Link-local 169.254.* is
// what an interface gets with no DHCP, so the phone can't reach it.
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) found.push({ name, address: a.address });
    }
  }
  return found.sort((x, y) => isPrivate(y.address) - isPrivate(x.address));
}

export function startupBanner(port, addrs) {
  if (!addrs.length) {
    return ["No LAN address. Join the phone's hotspot or the same Wi-Fi, then restart."];
  }
  return [
    ...addrs.map((a) => `LAN: http://${a.address}:${port} (${a.name})`),
    'On the gateway phone, in Termux (inside gateway-phone/):',
    ...addrs.map((a) => `  LAPTOP_URL=http://${a.address}:${port} node gateway.mjs`),
  ];
}
