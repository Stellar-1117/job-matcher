import { networkInterfaces } from 'node:os';
import { getSettings } from '../repos/settings';

/** Adapters for VMs and containers come up with private addresses that other laptops can't reach. */
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier/i;
const PRIVATE_IPV4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** The first private IPv4 address, preferring real network adapters. */
export function firstPrivateIpv4(interfaces = networkInterfaces()): string | null {
  const found: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && PRIVATE_IPV4.test(i.address)) found.push({ name, address: i.address });
    }
  }
  return (found.find((f) => !VIRTUAL_ADAPTER.test(f.name)) ?? found[0])?.address ?? null;
}

/** http://host:port, using the configured host if there is one. */
export function resumeServerAddress(): string {
  const { host, port } = getSettings().lan;
  return `http://${host ?? firstPrivateIpv4() ?? '127.0.0.1'}:${port}`;
}

export const resumeLink = (token: string): string => `${resumeServerAddress()}/r/${token}`;
