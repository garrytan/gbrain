import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export interface NetworkCandidate {
  adapterName: string;
  address: string;
  netmask: string;
  cidr: string | null;
  mac: string;
  virtual: boolean;
  recommended: boolean;
  warning?: string;
}

export type NetworkInterfaceSnapshot = NodeJS.Dict<NetworkInterfaceInfo[]>;

const VIRTUAL_ADAPTER_PATTERN = /(?:\bvethernet\b|\bwsl\b|hyper-?v|docker|tailscale|zero\s*tier|zerotier|vmware|virtualbox|wireguard|\bvpn\b|\bwintun\b|\btap\b|\btun(?:nel)?\b|hamachi|fortinet|anyconnect|clash|虚拟|环回)/i;

function isIpv4(info: NetworkInterfaceInfo): boolean {
  return info.family === 'IPv4' || (info.family as unknown) === 4;
}

function isAutomaticPrivateAddress(address: string): boolean {
  return address.startsWith('169.254.');
}

function isBenchmarkOrProxyAddress(address: string): boolean {
  const octets = address.split('.').map(Number);
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

export function isPrivateLanIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function classify(adapterName: string, address: string): Pick<NetworkCandidate, 'virtual' | 'recommended' | 'warning'> {
  if (VIRTUAL_ADAPTER_PATTERN.test(adapterName)) {
    return {
      virtual: true,
      recommended: false,
      warning: '这是虚拟、代理或隧道网卡，地址可能变化，默认不建议用于局域网共享。',
    };
  }
  if (isAutomaticPrivateAddress(address)) {
    return {
      virtual: false,
      recommended: false,
      warning: '这是系统自动分配的临时地址，网络恢复后通常会变化。',
    };
  }
  if (isBenchmarkOrProxyAddress(address)) {
    return {
      virtual: false,
      recommended: false,
      warning: '这是测试或代理软件常用地址段，默认不建议用于局域网共享。',
    };
  }
  if (!isPrivateLanIpv4(address)) {
    return {
      virtual: false,
      recommended: false,
      warning: '这不是 10.x、172.16-31.x 或 192.168.x 私有局域网地址，共享模式不会使用它。',
    };
  }
  return { virtual: false, recommended: true };
}

/**
 * Returns every external IPv4 address as an explicit choice. This function
 * deliberately does not select or reorder a replacement address for callers.
 */
export function listNetworkCandidates(
  snapshot: NetworkInterfaceSnapshot = networkInterfaces(),
): NetworkCandidate[] {
  const candidates: NetworkCandidate[] = [];
  for (const [adapterName, addresses] of Object.entries(snapshot)) {
    if (!addresses) continue;
    for (const info of addresses) {
      if (!isIpv4(info) || info.internal) continue;
      candidates.push({
        adapterName,
        address: info.address,
        netmask: info.netmask,
        cidr: info.cidr,
        mac: info.mac,
        ...classify(adapterName, info.address),
      });
    }
  }
  return candidates;
}

/**
 * Validates the persisted adapter/address pair exactly. A matching address on
 * another adapter, or a different address on the same adapter, is not accepted.
 */
export function isSelectedAddressAvailable(
  adapterName: string,
  address: string,
  snapshot: NetworkInterfaceSnapshot = networkInterfaces(),
): boolean {
  if (!adapterName || !address) return false;
  const addresses = snapshot[adapterName];
  return Boolean(addresses?.some((info) => (
    isIpv4(info)
    && !info.internal
    && info.address === address
  )));
}
