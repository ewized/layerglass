import type { AddressInfo, Server } from 'node:net';

export function fixtureAddress(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a listening TCP fixture');
  return address;
}

export function fixtureOrigin(server: Server): string {
  return `http://127.0.0.1:${fixtureAddress(server).port}`;
}
