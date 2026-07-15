import type {
  DesktopCloseBehavior,
  DesktopNetworkMode,
  DesktopPreferences,
  DesktopTheme,
} from './config-manager.js';
import type { LanMcpGatewayStatus } from './lan-mcp-gateway.js';
import type { NetworkCandidate } from './network-manager.js';

export interface DesktopSystemSettingsPayload {
  theme: DesktopTheme;
  networkMode: DesktopNetworkMode;
  sharedAdapter?: string;
  sharedIp?: string;
  launchAtLogin: boolean;
  closeBehavior: DesktopCloseBehavior;
}

export interface DesktopSystemSettingsState {
  preferences: DesktopPreferences;
  theme: {
    source: DesktopTheme;
    resolved: 'light' | 'dark';
  };
  launchAtLogin: boolean;
  networkCandidates: NetworkCandidate[];
  selectedAddressAvailable: boolean;
  localMcpUrl?: string;
  sharedMcpUrl?: string;
  gateway: LanMcpGatewayStatus | null;
  warning?: string;
}

export interface DesktopSystemSettingsSaveResult {
  canceled: boolean;
  state: DesktopSystemSettingsState;
  backup?: string | null;
}
