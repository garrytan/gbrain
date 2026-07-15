import { describe, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo, NetworkInterfaceInfoIPv4 } from 'node:os';
import {
  isPrivateLanIpv4,
  isSelectedAddressAvailable,
  listNetworkCandidates,
} from '../src/main/network-manager.js';

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

function ipv4(
  address: string,
  options: Partial<NetworkInterfaceInfoIPv4> = {},
): NetworkInterfaceInfoIPv4 {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: `${address}/24`,
    ...options,
  };
}

const interfaces: InterfaceMap = {
  'Wi-Fi': [ipv4('192.168.1.25')],
  'vEthernet (WSL (Hyper-V firewall))': [ipv4('192.168.112.1')],
  'Tailscale': [ipv4('100.72.10.8')],
  'vEthernet (Default Switch)': [ipv4('172.20.0.1')],
  'Ethernet': [ipv4('169.254.2.10')],
  'Mobile': [ipv4('33.252.174.218')],
  'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', { internal: true })],
  'IPv6 only': [{
    address: 'fe80::1',
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:11:22:33:44:66',
    internal: false,
    cidr: 'fe80::1/64',
    scopeid: 1,
  }],
};

describe('desktop network manager', () => {
  test('lists external IPv4 addresses and marks virtual adapters as non-recommended', () => {
    const candidates = listNetworkCandidates(interfaces);

    expect(candidates.map((candidate) => candidate.adapterName)).toEqual([
      'Wi-Fi',
      'vEthernet (WSL (Hyper-V firewall))',
      'Tailscale',
      'vEthernet (Default Switch)',
      'Ethernet',
      'Mobile',
    ]);
    expect(candidates[0]).toMatchObject({
      adapterName: 'Wi-Fi',
      address: '192.168.1.25',
      virtual: false,
      recommended: true,
    });
    expect(candidates[1]).toMatchObject({
      virtual: true,
      recommended: false,
    });
    expect(candidates[1]?.warning).toContain('虚拟');
    expect(candidates[2]).toMatchObject({
      virtual: true,
      recommended: false,
    });
    expect(candidates[3]).toMatchObject({
      virtual: true,
      recommended: false,
    });
    expect(candidates[4]).toMatchObject({
      virtual: false,
      recommended: false,
    });
    expect(candidates[4]?.warning).toContain('自动分配');
    expect(candidates[5]).toMatchObject({ recommended: false, virtual: false });
    expect(candidates[5]?.warning).toContain('私有局域网');
  });

  test('only classifies RFC1918 IPv4 ranges as private LAN addresses', () => {
    expect(isPrivateLanIpv4('10.8.0.2')).toBe(true);
    expect(isPrivateLanIpv4('172.16.1.2')).toBe(true);
    expect(isPrivateLanIpv4('172.31.255.2')).toBe(true);
    expect(isPrivateLanIpv4('192.168.1.2')).toBe(true);
    expect(isPrivateLanIpv4('172.32.1.2')).toBe(false);
    expect(isPrivateLanIpv4('100.64.1.2')).toBe(false);
    expect(isPrivateLanIpv4('33.252.174.218')).toBe(false);
  });

  test('validates the exact adapter and address without switching automatically', () => {
    expect(isSelectedAddressAvailable('Wi-Fi', '192.168.1.25', interfaces)).toBe(true);

    const changedAddress: InterfaceMap = {
      ...interfaces,
      'Wi-Fi': [ipv4('192.168.1.26')],
      'Ethernet 2': [ipv4('192.168.1.25')],
    };
    expect(isSelectedAddressAvailable('Wi-Fi', '192.168.1.25', changedAddress)).toBe(false);
    expect(isSelectedAddressAvailable('Ethernet 2', '192.168.1.25', changedAddress)).toBe(true);
  });
});
