import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  CommandReceivedEvent,
  FirmwareSelection,
  FirmwareUploadProgressEvent,
  FirmwareUploadResult,
  LedColor,
  PowerCommand,
  RadioRole,
  RadioState,
  ReceiverCommand,
  SikApi,
  UsbPort,
  SerialFrame,
} from './types';

const emptyRadio = (role: RadioRole): RadioState => ({
  role,
  connected: false,
  path: '',
  dutyCycle: role === 'left' ? 100 : 0,
  mode: role === 'left' ? 'broadcast' : 'receive',
  atMode: false,
  stats: null,
});

const commandColors: LedColor[] = ['red', 'blue', 'green', 'white', 'black', 'yellow', 'purple', 'custom'];
const powerCommands: PowerCommand[] = ['sleep', 'power-on'];

const browserFallbackApi: SikApi = {
  init: async () => ({
    ports: [],
    radios: { left: emptyRadio('left'), right: emptyRadio('right') },
    preferredPorts: { left: '', right: '' },
    customColor: '#ff8800',
    firmwareSelection: {
      path: '',
      defaultPath: '',
      usingDefault: true,
    },
  }),
  listPorts: async () => [],
  connectRadio: async (role) => emptyRadio(role),
  disconnectRadio: async (role) => emptyRadio(role),
  refreshRadioStats: async (role) => emptyRadio(role),
  setPreferredPort: async () => ({ left: '', right: '' }),
  setCustomColor: async (color) => ({ customColor: color }),
  pickFirmwareFile: async () => ({ path: '', defaultPath: '', usingDefault: true }),
  resetFirmwareFile: async () => ({ path: '', defaultPath: '', usingDefault: true }),
  setDutyCycle: async (role, dutyCycle) => ({
    ...emptyRadio(role),
    dutyCycle,
    mode: dutyCycle === 100 ? 'broadcast' : dutyCycle === 0 ? 'receive' : 'peer',
  }),
  uploadFirmware: async (_role, portPath) => ({
    ok: true,
    portPath,
    firmwarePath: '',
    output: '',
  }),
  sendLedCommand: async () => ({ ok: true }),
  sendPowerCommand: async () => ({ ok: true }),
  onPortsChanged: () => () => undefined,
  onRadioStatus: () => () => undefined,
  onSerialData: () => () => undefined,
  onCommandReceived: () => () => undefined,
  onUploadProgress: () => () => undefined,
};

const sikApi: SikApi = window.sik ?? browserFallbackApi;

function formatPortLabel(port: UsbPort): string {
  const vendor = port.vendorId ? `VID:${port.vendorId}` : 'VID:----';
  const product = port.productId ? `PID:${port.productId}` : 'PID:----';
  const maker = port.manufacturer || 'Unknown device';
  return `${port.path} (${vendor}/${product}) ${maker}`;
}

function formatFrameLine(frame: SerialFrame): string {
  const stamp = new Date(frame.timestamp).toLocaleTimeString();
  const suffix = frame.note ? ` | ${frame.note}` : '';
  return `${stamp} | ${frame.hex} | ${frame.ascii}${suffix}`;
}

function renderStatValue(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'Unknown';
  }
  return String(value);
}

function hasMeaningfulStats(radio: RadioState): boolean {
  return Boolean(
    radio.stats && (
      radio.stats.boardId !== null ||
      radio.stats.boardFrequencyCode !== null ||
      Object.keys(radio.stats.rawParameters).length > 0
    )
  );
}

function modeLabelFromDutyCycle(dutyCycle: number): string {
  if (dutyCycle === 100) {
    return 'broadcast';
  }
  if (dutyCycle === 0) {
    return 'receive';
  }
  return 'custom';
}

function colorButtonLabel(color: LedColor): string {
  if (color === 'custom') {
    return 'custom';
  }
  return color;
}

function colorButtonClass(color: LedColor): string {
  return color === 'custom' ? 'custom-color-button' : color;
}

function powerButtonLabel(command: PowerCommand): string {
  return command === 'power-on' ? 'power on' : 'sleep';
}

function getFileName(filePath: string): string {
  if (!filePath) {
    return 'None';
  }
  const normalized = filePath.replace(/\\/g, '/');
  const pieces = normalized.split('/');
  return pieces[pieces.length - 1] || filePath;
}

function App() {
  const [ports, setPorts] = useState<UsbPort[]>([]);
  const [leftRadio, setLeftRadio] = useState<RadioState>(emptyRadio('left'));
  const [rightRadio, setRightRadio] = useState<RadioState>(emptyRadio('right'));
  const [leftPortPath, setLeftPortPath] = useState('');
  const [rightPortPath, setRightPortPath] = useState('');
  const [txFrames, setTxFrames] = useState<string[]>([]);
  const [rxFrames, setRxFrames] = useState<string[]>([]);
  const [statusText, setStatusText] = useState('Waiting for USB radios...');
  const [uploadingRole, setUploadingRole] = useState<RadioRole | null>(null);
  const [uploadProgress, setUploadProgress] = useState<Record<RadioRole, number>>({ left: 0, right: 0 });
  const [uploadPhase, setUploadPhase] = useState<Record<RadioRole, FirmwareUploadProgressEvent['phase']>>({ left: 'starting', right: 'starting' });
  const [refreshingRole, setRefreshingRole] = useState<RadioRole | null>(null);
  const [wakeInProgress, setWakeInProgress] = useState(false);
  const [customColor, setCustomColor] = useState('#ff8800');
  const [firmwarePath, setFirmwarePath] = useState('');
  const [firmwareDefaultPath, setFirmwareDefaultPath] = useState('');
  const [firmwareUsingDefault, setFirmwareUsingDefault] = useState(true);
  const [rightCommandFlashAt, setRightCommandFlashAt] = useState<Record<ReceiverCommand, number>>({
    red: 0,
    blue: 0,
    green: 0,
    white: 0,
    black: 0,
    yellow: 0,
    purple: 0,
    custom: 0,
    sleep: 0,
    'power-on': 0,
  });
  const txLogRef = useRef<HTMLPreElement | null>(null);
  const rxLogRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const payload = await sikApi.init();
      if (!mounted) {
        return;
      }

      setPorts(payload.ports);
      setLeftRadio(payload.radios.left);
      setRightRadio(payload.radios.right);
      setLeftPortPath(payload.preferredPorts.left);
      setRightPortPath(payload.preferredPorts.right);
      setCustomColor(payload.customColor);
      setFirmwarePath(payload.firmwareSelection.path);
      setFirmwareDefaultPath(payload.firmwareSelection.defaultPath);
      setFirmwareUsingDefault(payload.firmwareSelection.usingDefault);
      setStatusText('Ready. Select USB radios or rely on saved auto-connect.');
    };

    void init();

    const offPorts = sikApi.onPortsChanged((nextPorts) => {
      setPorts(nextPorts);
    });

    const offStatus = sikApi.onRadioStatus((status) => {
      if (status.role === 'left') {
        setLeftRadio(status);
      } else {
        setRightRadio(status);
      }
    });

    const offSerial = sikApi.onSerialData((frame) => {
      const line = formatFrameLine(frame);
      if (frame.role === 'left' && frame.direction === 'tx') {
        setTxFrames((prev) => [...prev, line].slice(-160));
      }
      if (frame.role === 'right' && frame.direction === 'rx') {
        setRxFrames((prev) => [...prev, line].slice(-160));
      }
    });

    const offCommand = sikApi.onCommandReceived((event: CommandReceivedEvent) => {
      if (event.role === 'right') {
        setRightCommandFlashAt((prev) => ({
          ...prev,
          [event.color]: event.timestamp,
        }));
      }
    });

    const offUploadProgress = sikApi.onUploadProgress((event: FirmwareUploadProgressEvent) => {
      setUploadProgress((prev) => ({
        ...prev,
        [event.role]: Math.max(0, Math.min(100, event.percent)),
      }));
      setUploadPhase((prev) => ({
        ...prev,
        [event.role]: event.phase,
      }));
    });

    return () => {
      mounted = false;
      offPorts();
      offStatus();
      offSerial();
      offCommand();
      offUploadProgress();
    };
  }, []);

  const availablePortOptions = useMemo(() => {
    return ports.map((port) => ({ value: port.path, label: formatPortLabel(port) }));
  }, [ports]);

  useEffect(() => {
    if (txLogRef.current) {
      txLogRef.current.scrollTop = txLogRef.current.scrollHeight;
    }
  }, [txFrames]);

  useEffect(() => {
    if (rxLogRef.current) {
      rxLogRef.current.scrollTop = rxLogRef.current.scrollHeight;
    }
  }, [rxFrames]);

  const onSelectPort = async (role: RadioRole, portPath: string) => {
    if (wakeInProgress) {
      return;
    }

    if (role === 'left') {
      setLeftPortPath(portPath);
    } else {
      setRightPortPath(portPath);
    }

    await sikApi.setPreferredPort(role, portPath);

    if (!portPath) {
      await sikApi.disconnectRadio(role);
      setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} radio disconnected.`);
      return;
    }

    try {
      await sikApi.connectRadio(role, portPath);
      setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} radio connected: ${portPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed.';
      setStatusText(message);
    }
  };

  const onSetDutyCycle = async (role: RadioRole, value: string) => {
    if (wakeInProgress) {
      return;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }

    const bounded = Math.max(0, Math.min(100, parsed));
    try {
      await sikApi.setDutyCycle(role, bounded);
      setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} DUTY_CYCLE updated to ${bounded}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set DUTY_CYCLE.';
      setStatusText(message);
    }
  };

  const onApplyRoleMode = async (role: RadioRole, dutyCycle: number) => {
    if (wakeInProgress) {
      return;
    }

    try {
      await sikApi.setDutyCycle(role, dutyCycle);
      setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} role applied with DUTY_CYCLE=${dutyCycle}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply role mode.';
      setStatusText(message);
    }
  };

  const onRefreshStats = async (role: RadioRole) => {
    if (wakeInProgress) {
      return;
    }

    setRefreshingRole(role);
    try {
      const radio = await sikApi.refreshRadioStats(role);
      if (hasMeaningfulStats(radio)) {
        setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} radio stats refreshed.`);
      } else {
        setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} radio replied, but no stats were parsed. Check the Electron console for raw ATI output.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh radio stats.';
      setStatusText(message);
    } finally {
      setRefreshingRole((current) => (current === role ? null : current));
    }
  };

  const onSendLed = async (color: LedColor) => {
    if (wakeInProgress) {
      return;
    }

    try {
      await sikApi.sendLedCommand(color, customColor);
      setStatusText(`${color === 'custom' ? `Custom color ${customColor}` : `LED ${color.toUpperCase()}`} MAVLink command sent from broadcast radio.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send LED command.';
      setStatusText(message);
    }
  };

  const onCustomColorChange = async (value: string) => {
    if (wakeInProgress) {
      return;
    }

    setCustomColor(value);
    try {
      await sikApi.setCustomColor(value);
    } catch {
      // Keep local UI state even if persistence fails.
    }
  };

  const onSendPowerCommand = async (command: PowerCommand) => {
    if (wakeInProgress) {
      return;
    }

    const isWakeCommand = command === 'power-on';

    if (isWakeCommand) {
      setWakeInProgress(true);
      setStatusText('Waking up the drones...');
    }

    try {
      await sikApi.sendPowerCommand(command);
      setStatusText(isWakeCommand ? 'Wake-up command burst completed.' : `${powerButtonLabel(command)} MAVLink command sent from broadcast radio.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send power command.';
      setStatusText(message);
    } finally {
      if (isWakeCommand) {
        setWakeInProgress(false);
      }
    }
  };

  const applyFirmwareSelection = (selection: FirmwareSelection) => {
    setFirmwarePath(selection.path);
    setFirmwareDefaultPath(selection.defaultPath);
    setFirmwareUsingDefault(selection.usingDefault);
  };

  const onPickFirmwareFile = async () => {
    if (wakeInProgress || uploadingRole !== null) {
      return;
    }

    try {
      const selection = await sikApi.pickFirmwareFile();
      applyFirmwareSelection(selection);
      setStatusText(`Firmware selected: ${selection.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open firmware picker.';
      setStatusText(message);
    }
  };

  const onResetFirmwareFile = async () => {
    if (wakeInProgress || uploadingRole !== null) {
      return;
    }

    try {
      const selection = await sikApi.resetFirmwareFile();
      applyFirmwareSelection(selection);
      setStatusText(`Firmware reset to default: ${selection.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reset firmware path.';
      setStatusText(message);
    }
  };

  const onUploadFirmware = async (role: RadioRole) => {
    if (wakeInProgress) {
      return;
    }

    const portPath = role === 'left' ? leftPortPath : rightPortPath;

    if (!portPath) {
      setStatusText(`Select a USB port for the ${role === 'left' ? 'broadcast' : 'receiver'} radio before uploading firmware.`);
      return;
    }

    setUploadingRole(role);
    setUploadProgress((prev) => ({ ...prev, [role]: 0 }));
    setUploadPhase((prev) => ({ ...prev, [role]: 'starting' }));
    setStatusText(`Uploading firmware to ${role === 'left' ? 'broadcast' : 'receiver'} radio on ${portPath}...`);

    try {
      const result: FirmwareUploadResult = await sikApi.uploadFirmware(role, portPath);
      setUploadProgress((prev) => ({ ...prev, [role]: 100 }));
      setUploadPhase((prev) => ({ ...prev, [role]: 'done' }));
      setStatusText(`Firmware uploaded to ${result.portPath}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Firmware upload failed.';
      setUploadPhase((prev) => ({ ...prev, [role]: 'failed' }));
      setStatusText(message.split('\n')[0] || 'Firmware upload failed.');
    } finally {
      setUploadingRole(null);
    }
  };

  const isCommandFlashing = (color: ReceiverCommand): boolean => {
    const ageMs = Date.now() - rightCommandFlashAt[color];
    return ageMs >= 0 && ageMs <= 900;
  };

  return (
    <main className="shell">
      {wakeInProgress ? (
        <div className="blocking-popover" role="dialog" aria-modal="true" aria-labelledby="wake-title">
          <div className="blocking-popover__card">
            <h2 id="wake-title">Waking Up Drones</h2>
            <p>Sending the power on command every 250 ms for 12 seconds. Controls are temporarily locked.</p>
          </div>
        </div>
      ) : null}

      <header className="header">
        <h1>SiK Broadcast Console</h1>
        <p>Left radio is broadcast control, right radio is receive monitor.</p>
        <div className="status">{statusText}</div>
        <div className="firmware-picker">
          <div className="firmware-picker__line">
            <strong>Firmware:</strong>
            <span title={firmwarePath || firmwareDefaultPath}>
              {getFileName(firmwarePath || firmwareDefaultPath)}
            </span>
            <span className={`chip ${firmwareUsingDefault ? 'ok' : 'off'}`}>
              {firmwareUsingDefault ? 'Default' : 'Custom'}
            </span>
          </div>
          <div className="firmware-actions">
            <button className="action-button secondary" disabled={wakeInProgress || uploadingRole !== null} onClick={() => void onPickFirmwareFile()}>
              Choose File...
            </button>
            <button className="action-button" disabled={wakeInProgress || uploadingRole !== null || firmwareUsingDefault} onClick={() => void onResetFirmwareFile()}>
              Use Default
            </button>
          </div>
        </div>
      </header>

      <section className="grid">
        <article className="panel left">
          <h2>Broadcast Radio (Left)</h2>

          <label className="field">
            <span>USB Port</span>
            <select value={leftPortPath} onChange={(event) => void onSelectPort('left', event.target.value)}>
              <option value="">Select broadcast USB radio...</option>
              {availablePortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="field-inline">
            <label>
              DUTY_CYCLE
              <input
                type="number"
                min={0}
                max={100}
                value={leftRadio.dutyCycle}
                onChange={(event) => void onSetDutyCycle('left', event.target.value)}
              />
            </label>
            <span className="mode">Mode: {modeLabelFromDutyCycle(leftRadio.dutyCycle)}</span>
            <span className={`chip ${leftRadio.atMode ? 'ok' : 'off'}`}>
              AT Mode: {leftRadio.atMode ? 'On' : 'Off'}
            </span>
            <span className={`chip ${leftRadio.connected ? 'ok' : 'off'}`}>
              {leftRadio.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          <div className="firmware-actions">
            <button
              className="action-button secondary"
              disabled={!leftRadio.connected}
              onClick={() => void onApplyRoleMode('left', 100)}
            >
              Set Broadcaster Mode
            </button>
            <button
              className="action-button"
              disabled={!leftRadio.connected || refreshingRole !== null}
              onClick={() => void onRefreshStats('left')}
            >
              {refreshingRole === 'left' ? 'Refreshing Stats...' : 'Refresh Stats'}
            </button>
          </div>

          <div className="stats-panel">
            <h3>Radio Stats</h3>
            <div className="stats-grid">
              <div className="stat-item"><span>Board ID</span><strong>{renderStatValue(leftRadio.stats?.boardId)}</strong></div>
              <div className="stat-item"><span>RF Band</span><strong>{renderStatValue(leftRadio.stats?.boardFrequencyLabel ?? null)}</strong></div>
              <div className="stat-item"><span>Serial Speed</span><strong>{renderStatValue(leftRadio.stats?.serialSpeed)}</strong></div>
              <div className="stat-item"><span>Air Speed</span><strong>{renderStatValue(leftRadio.stats?.airSpeed)}</strong></div>
              <div className="stat-item"><span>NETID</span><strong>{renderStatValue(leftRadio.stats?.netId)}</strong></div>
              <div className="stat-item"><span>TX Power</span><strong>{renderStatValue(leftRadio.stats?.txPower)}</strong></div>
              <div className="stat-item"><span>Min Freq</span><strong>{renderStatValue(leftRadio.stats?.minFreq)}</strong></div>
              <div className="stat-item"><span>Max Freq</span><strong>{renderStatValue(leftRadio.stats?.maxFreq)}</strong></div>
              <div className="stat-item"><span>Num Channels</span><strong>{renderStatValue(leftRadio.stats?.numChannels)}</strong></div>
              <div className="stat-item"><span>DUTY_CYCLE</span><strong>{renderStatValue(leftRadio.stats?.dutyCycle ?? leftRadio.dutyCycle)}</strong></div>
              <div className="stat-item"><span>Max Window</span><strong>{renderStatValue(leftRadio.stats?.maxWindow)}</strong></div>
            </div>
          </div>

          <div className="firmware-actions">
            <button
              className={`action-button ${uploadingRole === 'left' ? 'upload-progress' : ''}`}
              style={uploadingRole === 'left' ? ({ '--upload-progress': `${uploadProgress.left}%` } as CSSProperties) : undefined}
              disabled={!leftPortPath || uploadingRole !== null}
              onClick={() => void onUploadFirmware('left')}
            >
              <span>
                {uploadingRole === 'left'
                  ? `${uploadPhase.left === 'verifying' ? 'Verifying' : uploadPhase.left === 'programming' ? 'Programming' : 'Uploading'} ${uploadProgress.left}%`
                  : 'Upload Firmware'}
              </span>
            </button>
            <span className="firmware-note">Uses {getFileName(firmwarePath || firmwareDefaultPath)}</span>
          </div>

          <div className="commands">
            <h3>LED MAVLink Commands</h3>
            <div className="command-grid compact">
              {commandColors.map((color) => (
                <button
                  key={color}
                  className={`led small ${colorButtonClass(color)}`}
                  style={color === 'custom' ? { background: customColor, color: '#071016' } : undefined}
                  disabled={!leftRadio.connected || leftRadio.mode !== 'broadcast'}
                  onClick={() => void onSendLed(color)}
                >
                  {colorButtonLabel(color)}
                </button>
              ))}
            </div>
            <div className="custom-color-row">
              <label className="color-picker-label">
                <span>Custom Color</span>
                <input type="color" value={customColor} onChange={(event) => void onCustomColorChange(event.target.value)} />
              </label>
            </div>
          </div>

          <div className="commands">
            <h3>Power Commands</h3>
            <div className="command-grid compact two-up">
              {powerCommands.map((command) => (
                <button
                  key={command}
                  className={`led small power-button ${command}`}
                  disabled={!leftRadio.connected || leftRadio.mode !== 'broadcast'}
                  onClick={() => void onSendPowerCommand(command)}
                >
                  {powerButtonLabel(command)}
                </button>
              ))}
            </div>
          </div>

          <div className="bytes">
            <h3>Transmitted Bytes (TX)</h3>
            <pre ref={txLogRef} className="log-output">{txFrames.length > 0 ? txFrames.join('\n') : 'No TX bytes yet.'}</pre>
          </div>

        </article>

        <article className="panel right">
          <h2>Receive Radio (Right)</h2>

          <label className="field">
            <span>USB Port</span>
            <select value={rightPortPath} onChange={(event) => void onSelectPort('right', event.target.value)}>
              <option value="">Select receiver USB radio...</option>
              {availablePortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="field-inline">
            <label>
              DUTY_CYCLE
              <input
                type="number"
                min={0}
                max={100}
                value={rightRadio.dutyCycle}
                onChange={(event) => void onSetDutyCycle('right', event.target.value)}
              />
            </label>
            <span className="mode">Mode: {modeLabelFromDutyCycle(rightRadio.dutyCycle)}</span>
            <span className={`chip ${rightRadio.atMode ? 'ok' : 'off'}`}>
              AT Mode: {rightRadio.atMode ? 'On' : 'Off'}
            </span>
            <span className={`chip ${rightRadio.connected ? 'ok' : 'off'}`}>
              {rightRadio.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          <div className="firmware-actions">
            <button
              className="action-button secondary"
              disabled={!rightRadio.connected}
              onClick={() => void onApplyRoleMode('right', 0)}
            >
              Set Receiver Mode
            </button>
            <button
              className="action-button"
              disabled={!rightRadio.connected || refreshingRole !== null}
              onClick={() => void onRefreshStats('right')}
            >
              {refreshingRole === 'right' ? 'Refreshing Stats...' : 'Refresh Stats'}
            </button>
          </div>

          <div className="stats-panel">
            <h3>Radio Stats</h3>
            <div className="stats-grid">
              <div className="stat-item"><span>Board ID</span><strong>{renderStatValue(rightRadio.stats?.boardId)}</strong></div>
              <div className="stat-item"><span>RF Band</span><strong>{renderStatValue(rightRadio.stats?.boardFrequencyLabel ?? null)}</strong></div>
              <div className="stat-item"><span>Serial Speed</span><strong>{renderStatValue(rightRadio.stats?.serialSpeed)}</strong></div>
              <div className="stat-item"><span>Air Speed</span><strong>{renderStatValue(rightRadio.stats?.airSpeed)}</strong></div>
              <div className="stat-item"><span>NETID</span><strong>{renderStatValue(rightRadio.stats?.netId)}</strong></div>
              <div className="stat-item"><span>TX Power</span><strong>{renderStatValue(rightRadio.stats?.txPower)}</strong></div>
              <div className="stat-item"><span>Min Freq</span><strong>{renderStatValue(rightRadio.stats?.minFreq)}</strong></div>
              <div className="stat-item"><span>Max Freq</span><strong>{renderStatValue(rightRadio.stats?.maxFreq)}</strong></div>
              <div className="stat-item"><span>Num Channels</span><strong>{renderStatValue(rightRadio.stats?.numChannels)}</strong></div>
              <div className="stat-item"><span>DUTY_CYCLE</span><strong>{renderStatValue(rightRadio.stats?.dutyCycle ?? rightRadio.dutyCycle)}</strong></div>
              <div className="stat-item"><span>Max Window</span><strong>{renderStatValue(rightRadio.stats?.maxWindow)}</strong></div>
            </div>
          </div>

          <div className="firmware-actions">
            <button
              className={`action-button ${uploadingRole === 'right' ? 'upload-progress' : ''}`}
              style={uploadingRole === 'right' ? ({ '--upload-progress': `${uploadProgress.right}%` } as CSSProperties) : undefined}
              disabled={!rightPortPath || uploadingRole !== null}
              onClick={() => void onUploadFirmware('right')}
            >
              <span>
                {uploadingRole === 'right'
                  ? `${uploadPhase.right === 'verifying' ? 'Verifying' : uploadPhase.right === 'programming' ? 'Programming' : 'Uploading'} ${uploadProgress.right}%`
                  : 'Upload Firmware'}
              </span>
            </button>
            <span className="firmware-note">Uses {getFileName(firmwarePath || firmwareDefaultPath)}</span>
          </div>

          <div className="commands">
            <h3>Received Commands</h3>
            <div className="command-grid compact">
              {commandColors.map((color) => (
                <button
                  key={color}
                  className={`led small ${colorButtonClass(color)} ghost ${isCommandFlashing(color) ? 'flash' : ''}`}
                  style={color === 'custom' ? { background: customColor, color: '#071016' } : undefined}
                  disabled
                >
                  {colorButtonLabel(color)}
                </button>
              ))}
            </div>
            <div className="command-grid compact two-up">
              {powerCommands.map((command) => (
                <button
                  key={command}
                  className={`led small power-button ${command} ghost ${isCommandFlashing(command) ? 'flash' : ''}`}
                  disabled
                >
                  {powerButtonLabel(command)}
                </button>
              ))}
            </div>
          </div>

          <div className="bytes">
            <h3>Received Bytes (RX)</h3>
            <pre ref={rxLogRef} className="log-output">{rxFrames.length > 0 ? rxFrames.join('\n') : 'No RX bytes yet.'}</pre>
          </div>

        </article>
      </section>
    </main>
  );
}

export default App;
