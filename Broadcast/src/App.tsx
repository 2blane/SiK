import { useEffect, useMemo, useState } from 'react';
import type {
  CommandReceivedEvent,
  FirmwareUploadResult,
  LedColor,
  RadioRole,
  RadioState,
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

const commandColors: LedColor[] = ['red', 'blue', 'green', 'white'];

const browserFallbackApi: SikApi = {
  init: async () => ({
    ports: [],
    radios: { left: emptyRadio('left'), right: emptyRadio('right') },
    preferredPorts: { left: '', right: '' },
  }),
  listPorts: async () => [],
  connectRadio: async (role) => emptyRadio(role),
  disconnectRadio: async (role) => emptyRadio(role),
  refreshRadioStats: async (role) => emptyRadio(role),
  setPreferredPort: async () => ({ left: '', right: '' }),
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
  onPortsChanged: () => () => undefined,
  onRadioStatus: () => () => undefined,
  onSerialData: () => () => undefined,
  onCommandReceived: () => () => undefined,
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
  const [refreshingRole, setRefreshingRole] = useState<RadioRole | null>(null);
  const [rightCommandFlashAt, setRightCommandFlashAt] = useState<Record<LedColor, number>>({
    red: 0,
    blue: 0,
    green: 0,
    white: 0,
  });

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
        setTxFrames((prev) => [line, ...prev].slice(0, 160));
      }
      if (frame.role === 'right' && frame.direction === 'rx') {
        setRxFrames((prev) => [line, ...prev].slice(0, 160));
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

    return () => {
      mounted = false;
      offPorts();
      offStatus();
      offSerial();
      offCommand();
    };
  }, []);

  const availablePortOptions = useMemo(() => {
    return ports.map((port) => ({ value: port.path, label: formatPortLabel(port) }));
  }, [ports]);

  const onSelectPort = async (role: RadioRole, portPath: string) => {
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
    try {
      await sikApi.setDutyCycle(role, dutyCycle);
      setStatusText(`${role === 'left' ? 'Broadcast' : 'Receiver'} role applied with DUTY_CYCLE=${dutyCycle}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply role mode.';
      setStatusText(message);
    }
  };

  const onRefreshStats = async (role: RadioRole) => {
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
    try {
      await sikApi.sendLedCommand(color);
      setStatusText(`LED ${color.toUpperCase()} MAVLink command sent from broadcast radio.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send LED command.';
      setStatusText(message);
    }
  };

  const onUploadFirmware = async (role: RadioRole) => {
    const portPath = role === 'left' ? leftPortPath : rightPortPath;

    if (!portPath) {
      setStatusText(`Select a USB port for the ${role === 'left' ? 'broadcast' : 'receiver'} radio before uploading firmware.`);
      return;
    }

    setUploadingRole(role);
    setStatusText(`Uploading firmware to ${role === 'left' ? 'broadcast' : 'receiver'} radio on ${portPath}...`);

    try {
      const result: FirmwareUploadResult = await sikApi.uploadFirmware(role, portPath);
      const outputSuffix = result.output ? ` ${result.output}` : '';
      setStatusText(`Firmware uploaded to ${result.portPath}.${outputSuffix}`.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Firmware upload failed.';
      setStatusText(message);
    } finally {
      setUploadingRole(null);
    }
  };

  const isCommandFlashing = (color: LedColor): boolean => {
    const ageMs = Date.now() - rightCommandFlashAt[color];
    return ageMs >= 0 && ageMs <= 900;
  };

  return (
    <main className="shell">
      <header className="header">
        <h1>SiK Broadcast Console</h1>
        <p>Left radio is broadcast control, right radio is receive monitor.</p>
        <div className="status">{statusText}</div>
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
              className="action-button"
              disabled={!leftPortPath || uploadingRole !== null}
              onClick={() => void onUploadFirmware('left')}
            >
              {uploadingRole === 'left' ? 'Uploading Firmware...' : 'Upload Firmware'}
            </button>
            <span className="firmware-note">Uses Firmware/dst/radio~hm_trp.ihx</span>
          </div>

          <div className="commands">
            <h3>LED MAVLink Commands</h3>
            <div className="command-grid">
              {commandColors.map((color) => (
                <button
                  key={color}
                  className={`led ${color}`}
                  disabled={!leftRadio.connected || leftRadio.mode !== 'broadcast'}
                  onClick={() => void onSendLed(color)}
                >
                  LED {color.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="bytes">
            <h3>Transmitted Bytes (TX)</h3>
            <pre>{txFrames.length > 0 ? txFrames.join('\n') : 'No TX bytes yet.'}</pre>
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
              className="action-button"
              disabled={!rightPortPath || uploadingRole !== null}
              onClick={() => void onUploadFirmware('right')}
            >
              {uploadingRole === 'right' ? 'Uploading Firmware...' : 'Upload Firmware'}
            </button>
            <span className="firmware-note">Uses Firmware/dst/radio~hm_trp.ihx</span>
          </div>

          <div className="commands">
            <h3>Received Commands</h3>
            <div className="command-grid">
              {commandColors.map((color) => (
                <button
                  key={color}
                  className={`led ${color} ghost ${isCommandFlashing(color) ? 'flash' : ''}`}
                  disabled
                >
                  LED {color.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="bytes">
            <h3>Received Bytes (RX)</h3>
            <pre>{rxFrames.length > 0 ? rxFrames.join('\n') : 'No RX bytes yet.'}</pre>
          </div>

        </article>
      </section>
    </main>
  );
}

export default App;
