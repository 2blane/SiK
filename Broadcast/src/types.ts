export type RadioRole = 'left' | 'right';
export type RadioMode = 'broadcast' | 'receive' | 'peer';
export type LedColor = 'red' | 'blue' | 'green' | 'white' | 'black' | 'yellow' | 'purple' | 'custom';
export type PowerCommand = 'sleep' | 'power-on';
export type ReceiverCommand = LedColor | PowerCommand;

export interface UsbPort {
  path: string;
  manufacturer: string;
  serialNumber: string;
  vendorId: string;
  productId: string;
}

export interface RadioState {
  role: RadioRole;
  connected: boolean;
  path: string;
  dutyCycle: number;
  mode: RadioMode;
  atMode: boolean;
  stats: RadioStats | null;
}

export interface RadioStats {
  boardId: number | null;
  boardFrequencyCode: number | null;
  boardFrequencyLabel: string;
  serialSpeed: number | null;
  airSpeed: number | null;
  netId: number | null;
  txPower: number | null;
  minFreq: number | null;
  maxFreq: number | null;
  numChannels: number | null;
  dutyCycle: number | null;
  maxWindow: number | null;
  rawParameters: Record<string, number>;
}

export interface SerialFrame {
  role: RadioRole;
  direction: 'tx' | 'rx';
  hex: string;
  ascii: string;
  note?: string;
  timestamp: number;
}

export interface CommandReceivedEvent {
  role: RadioRole;
  color: ReceiverCommand;
  timestamp: number;
}

export interface FirmwareUploadResult {
  ok: boolean;
  portPath: string;
  firmwarePath: string;
  output: string;
}

export interface InitPayload {
  ports: UsbPort[];
  radios: {
    left: RadioState;
    right: RadioState;
  };
  preferredPorts: {
    left: string;
    right: string;
  };
  customColor: string;
}

export interface SikApi {
  init: () => Promise<InitPayload>;
  listPorts: () => Promise<UsbPort[]>;
  connectRadio: (role: RadioRole, portPath: string) => Promise<RadioState>;
  disconnectRadio: (role: RadioRole) => Promise<RadioState>;
  refreshRadioStats: (role: RadioRole) => Promise<RadioState>;
  setPreferredPort: (role: RadioRole, portPath: string) => Promise<{ left: string; right: string }>;
  setCustomColor: (color: string) => Promise<{ customColor: string }>;
  setDutyCycle: (role: RadioRole, dutyCycle: number) => Promise<RadioState>;
  uploadFirmware: (role: RadioRole, portPath: string) => Promise<FirmwareUploadResult>;
  sendLedCommand: (color: LedColor, customColor?: string) => Promise<{ ok: boolean }>;
  sendPowerCommand: (command: PowerCommand) => Promise<{ ok: boolean }>;
  onPortsChanged: (callback: (ports: UsbPort[]) => void) => () => void;
  onRadioStatus: (callback: (status: RadioState) => void) => () => void;
  onSerialData: (callback: (frame: SerialFrame) => void) => () => void;
  onCommandReceived: (callback: (event: CommandReceivedEvent) => void) => () => void;
}
