const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, BrowserWindow, ipcMain } = require('electron');
const { SerialPort } = require('serialport');

const execFileAsync = promisify(execFile);

const rendererUrl = 'http://localhost:5173';
const portActivity = new WeakMap();

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {NodeJS.Timeout | null} */
let portPollTimer = null;

const LED_TO_RELAY_INDEX = {
  red: 1,
  blue: 2,
  green: 3,
  white: 4
};

const RELAY_INDEX_TO_COLOR = {
  1: 'red',
  2: 'blue',
  3: 'green',
  4: 'white'
};

const MAVLINK_MSG_ID_COMMAND_LONG = 76;
const MAVLINK_COMMAND_DO_SET_RELAY = 181;
const MAVLINK_SYSTEM_ID_GCS = 255;
const MAVLINK_COMPONENT_ID_GCS = 190;
const MAVLINK_COMMAND_LONG_CRC_EXTRA = 152;

let mavlinkSequence = 0;

const settingsDefaults = {
  preferredPorts: {
    left: '',
    right: ''
  },
  dutyCycles: {
    left: 100,
    right: 0
  }
};

const radios = {
  left: {
    role: 'left',
    connected: false,
    path: '',
    dutyCycle: 100,
    mode: 'broadcast',
    atMode: false,
    stats: null,
    mavlinkRxBuffer: Buffer.alloc(0),
    port: null
  },
  right: {
    role: 'right',
    connected: false,
    path: '',
    dutyCycle: 0,
    mode: 'receive',
    atMode: false,
    stats: null,
    mavlinkRxBuffer: Buffer.alloc(0),
    port: null
  }
};

function setRadioAtMode(role, atMode) {
  const radio = radios[role];
  if (!radio) {
    return;
  }

  if (radio.atMode !== atMode) {
    radio.atMode = atMode;
    emitRadioStatus(role);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markPortActivity(port) {
  portActivity.set(port, Date.now());
}

function getPortSilentDuration(port) {
  const lastActivityAt = portActivity.get(port) ?? 0;
  return Date.now() - lastActivityAt;
}

async function waitForPortSilence(port, { silenceMs = 1100, timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (getPortSilentDuration(port) >= silenceMs) {
      return;
    }

    await sleep(80);
  }

  throw new Error('Radio is actively streaming data, so it cannot enter AT mode for stats refresh right now. Wait for a quiet gap and try again.');
}

function writeToPort(port, payload) {
  return new Promise((resolve, reject) => {
    port.write(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }

      port.drain((drainError) => {
        if (drainError) {
          reject(drainError);
          return;
        }
        markPortActivity(port);
        resolve(undefined);
      });
    });
  });
}

function flushPort(port) {
  return new Promise((resolve, reject) => {
    port.flush((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}

function collectPortOutput(port, { timeoutMs = 1500, idleMs = 220 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let idleTimer = null;
    let timeoutTimer = null;
    let sawData = false;

    const finish = () => {
      clearTimeout(idleTimer);
      clearTimeout(timeoutTimer);
      port.removeListener('data', onData);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk) => {
      sawData = true;
      chunks.push(Buffer.from(chunk));
      markPortActivity(port);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleMs);
    };

    port.on('data', onData);
    timeoutTimer = setTimeout(finish, timeoutMs);
  });
}

function escapeForLog(value) {
  return value
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function emitStatsDebug(role, message, extra = {}) {
  const payload = {
    role,
    message,
    timestamp: Date.now(),
    ...extra
  };

  console.log('[radio:statsDebug]', payload);
  sendToRenderer('radio:statsDebug', payload);
}

function hasMeaningfulStats(stats) {
  return Boolean(
    stats && (
      stats.boardId !== null ||
      stats.boardFrequencyCode !== null ||
      Object.keys(stats.rawParameters).length > 0
    )
  );
}

function looksLikeAtBanner(output) {
  const upper = output.toUpperCase();
  return upper.includes('SIK') || upper.includes('OK');
}

async function exitAtMode(port, role) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const output = await sendAtCommand(port, 'ATO', {
      timeoutMs: 900,
      idleMs: 250,
      leadingBreak: false
    });
    const upper = output.toUpperCase();

    emitStatsDebug(role, `ATO exit response (attempt ${attempt}/3).`, {
      raw: { atoOutput: escapeForLog(output) }
    });

    // Some SiK builds only echo "ATO" when leaving command mode.
    if (!output || upper.includes('OK') || upper.includes('ATO')) {
      await sleep(100);
      const probeOutput = await sendAtCommand(port, 'ATI', {
        timeoutMs: 700,
        idleMs: 220,
        leadingBreak: false
      });

      emitStatsDebug(role, `Post-ATO ATI probe (attempt ${attempt}/3).`, {
        raw: { probeOutput: escapeForLog(probeOutput) }
      });

      // If ATI no longer gets an AT-style response, we are back in data mode.
      if (!looksLikeAtBanner(probeOutput)) {
        setRadioAtMode(role, false);
        return;
      }
    }
  }

  // Best-effort fallback: assume command mode is no longer active after ATO attempts.
  setRadioAtMode(role, false);
}

async function ensureAtMode(port, role) {
  emitStatsDebug(role, 'Checking if radio is already in AT mode.');
  const initialProbe = await sendAtCommand(port, 'ATI', {
    timeoutMs: 1200,
    idleMs: 350,
    leadingBreak: false
  });

  emitStatsDebug(role, 'Initial ATI probe response.', {
    raw: { atiProbeOutput: escapeForLog(initialProbe) }
  });

  if (looksLikeAtBanner(initialProbe)) {
    setRadioAtMode(role, true);
    return {
      mode: 'already-at',
      escapeOutput: '',
      atiProbeOutput: initialProbe
    };
  }

  const entered = await enterAtMode(port, role);
  return {
    mode: 'escape-sequence',
    ...entered
  };
}

async function enterAtMode(port, role, { attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    emitStatsDebug(role, `AT-mode entry attempt ${attempt}/${attempts}: flushing and waiting for silence.`);
    await flushPort(port);
    await writeToPort(port, '\r\n');
    await sleep(1000);
    await waitForPortSilence(port);

    await writeToPort(port, '+++');
    const escapeOutput = await collectPortOutput(port, { timeoutMs: 2600, idleMs: 1200 });
    emitStatsDebug(role, `Escape sequence response (attempt ${attempt}/${attempts}).`, {
      raw: { enterAtOutput: escapeForLog(escapeOutput) }
    });

    const atiProbe = await sendAtCommand(port, 'ATI', {
      timeoutMs: 1200,
      idleMs: 350,
      leadingBreak: false
    });
    emitStatsDebug(role, `ATI probe response (attempt ${attempt}/${attempts}).`, {
      raw: { atiProbeOutput: escapeForLog(atiProbe) }
    });

    if (looksLikeAtBanner(escapeOutput) || looksLikeAtBanner(atiProbe)) {
      setRadioAtMode(role, true);
      return { escapeOutput, atiProbeOutput: atiProbe };
    }

    await sleep(180);
  }

  throw new Error('Failed to enter AT mode to read radio stats.');
}

async function sendAtCommand(port, command, options = {}) {
  const { leadingBreak = true, ...collectOptions } = options;
  const payload = leadingBreak ? `\r\n${command}\r\n` : `${command}\r\n`;

  await writeToPort(port, payload);
  return collectPortOutput(port, collectOptions);
}

async function queryAtCommandWithRetry(port, role, command, isUsefulOutput, {
  attempts = 3,
  timeoutMs = 2200,
  idleMs = 450,
  delayMs = 120,
} = {}) {
  let lastOutput = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const output = await sendAtCommand(port, command, {
      timeoutMs,
      idleMs,
      leadingBreak: false
    });
    lastOutput = output;

    emitStatsDebug(role, `${command} response received (attempt ${attempt}/${attempts}).`, {
      raw: { output: escapeForLog(output) }
    });

    if (isUsefulOutput(output)) {
      return output;
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return lastOutput;
}

function extractNumericResponse(rawValue) {
  const match = rawValue.match(/(^|\n)\s*(\d+)\s*(?=\n|$)/);
  return match ? Number.parseInt(match[2], 10) : null;
}

function mapBoardFrequency(code) {
  switch (code) {
    case 0x43:
      return '433 MHz';
    case 0x47:
      return '470 MHz';
    case 0x86:
      return '868 MHz';
    case 0x91:
      return '915 MHz';
    default:
      return `Unknown (${code})`;
  }
}

function parseAti5Response(rawValue) {
  const entries = {};
  const matches = rawValue.matchAll(/S\d+:([A-Z0-9_]+)=(\d+)/g);

  for (const match of matches) {
    entries[match[1]] = Number.parseInt(match[2], 10);
  }

  return entries;
}

async function queryRadioStats(port, role = 'unknown') {
  emitStatsDebug(role, 'Starting radio stats query.');

  let atSession = null;
  try {
    atSession = await ensureAtMode(port, role);
    const { escapeOutput, atiProbeOutput } = atSession;

    await sendAtCommand(port, '', { timeoutMs: 250, idleMs: 120, leadingBreak: false });
    emitStatsDebug(role, 'AT mode confirmed. Querying ATI2, ATI3, and ATI5.');

    const ati2Output = await queryAtCommandWithRetry(
      port,
      role,
      'ATI2',
      (output) => extractNumericResponse(output) !== null,
      { attempts: 3, timeoutMs: 2200, idleMs: 500 }
    );
    emitStatsDebug(role, 'ATI2 response received.', {
      raw: { ati2Output: escapeForLog(ati2Output) }
    });

    const ati3Output = await queryAtCommandWithRetry(
      port,
      role,
      'ATI3',
      (output) => extractNumericResponse(output) !== null,
      { attempts: 3, timeoutMs: 2200, idleMs: 500 }
    );
    emitStatsDebug(role, 'ATI3 response received.', {
      raw: { ati3Output: escapeForLog(ati3Output) }
    });

    const ati5Output = await queryAtCommandWithRetry(
      port,
      role,
      'ATI5',
      (output) => Object.keys(parseAti5Response(output)).length > 0,
      { attempts: 4, timeoutMs: 3600, idleMs: 650 }
    );
    emitStatsDebug(role, 'ATI5 response received.', {
      raw: { ati5Output: escapeForLog(ati5Output) }
    });

    const boardId = extractNumericResponse(ati2Output);
    const boardFrequencyCode = extractNumericResponse(ati3Output);
    const parameters = parseAti5Response(ati5Output);

    const stats = {
      boardId,
      boardFrequencyCode,
      boardFrequencyLabel: boardFrequencyCode === null ? 'Unknown' : mapBoardFrequency(boardFrequencyCode),
      serialSpeed: parameters.SERIAL_SPEED ?? null,
      airSpeed: parameters.AIR_SPEED ?? null,
      netId: parameters.NETID ?? null,
      txPower: parameters.TXPOWER ?? null,
      minFreq: parameters.MIN_FREQ ?? null,
      maxFreq: parameters.MAX_FREQ ?? null,
      numChannels: parameters.NUM_CHANNELS ?? null,
      dutyCycle: parameters.DUTY_CYCLE ?? null,
      maxWindow: parameters.MAX_WINDOW ?? null,
      rawParameters: parameters
    };

    emitStatsDebug(role, hasMeaningfulStats(stats) ? 'Parsed meaningful radio stats.' : 'Radio replied, but no meaningful stats were parsed.', {
      raw: {
        enterAtOutput: escapeForLog(escapeOutput),
        atiProbeOutput: escapeForLog(atiProbeOutput),
        ati2Output: escapeForLog(ati2Output),
        ati3Output: escapeForLog(ati3Output),
        ati5Output: escapeForLog(ati5Output)
      },
      parsed: stats,
      meaningful: hasMeaningfulStats(stats)
    });

    return stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown radio stats error.';
    emitStatsDebug(role, `Stats query failed: ${message}`, {
      meaningful: false
    });
    throw error;
  } finally {
    if (atSession) {
      try {
        await exitAtMode(port, role);
      } catch (exitError) {
        const message = exitError instanceof Error ? exitError.message : 'Unknown ATO exit error.';
        emitStatsDebug(role, `Failed to exit AT mode cleanly: ${message}`);
      }
    }
  }
}

function getRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function getRendererDistPath() {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

function canConnectToDevServer(urlString) {
  return new Promise((resolve) => {
    const request = http.get(urlString, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode < 500);
    });

    request.on('error', () => resolve(false));
    request.setTimeout(1200, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function getFirmwarePaths() {
  const repoRoot = getRepoRoot();
  const firmwareDir = path.join(repoRoot, 'Firmware');

  return {
    firmwareDir,
    uploaderPath: path.join(firmwareDir, 'tools', 'uploader.py'),
    firmwarePath: path.join(firmwareDir, 'dst', 'radio~hm_trp.ihx')
  };
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'sik-settings.json');
}

function readSettings() {
  const filePath = getSettingsPath();
  if (!fs.existsSync(filePath)) {
    return structuredClone(settingsDefaults);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      preferredPorts: {
        left: parsed?.preferredPorts?.left ?? settingsDefaults.preferredPorts.left,
        right: parsed?.preferredPorts?.right ?? settingsDefaults.preferredPorts.right
      },
      dutyCycles: {
        left: Number.isFinite(parsed?.dutyCycles?.left) ? parsed.dutyCycles.left : settingsDefaults.dutyCycles.left,
        right: Number.isFinite(parsed?.dutyCycles?.right) ? parsed.dutyCycles.right : settingsDefaults.dutyCycles.right
      }
    };
  } catch {
    return structuredClone(settingsDefaults);
  }
}

function writeSettings(nextSettings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(nextSettings, null, 2), 'utf8');
}

function modeFromDutyCycle(dutyCycle) {
  if (dutyCycle === 100) {
    return 'broadcast';
  }
  if (dutyCycle === 0) {
    return 'receive';
  }
  return 'peer';
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function listPortsSafe() {
  return SerialPort.list().catch(() => []);
}

function normalizePort(port) {
  return {
    path: port.path,
    manufacturer: port.manufacturer ?? '',
    serialNumber: port.serialNumber ?? '',
    vendorId: port.vendorId ?? '',
    productId: port.productId ?? ''
  };
}

function serializeRadio(radio) {
  return {
    role: radio.role,
    connected: radio.connected,
    path: radio.path,
    dutyCycle: radio.dutyCycle,
    mode: radio.mode,
    atMode: radio.atMode,
    stats: radio.stats
  };
}

function emitRadioStatus(role) {
  sendToRenderer('radio:status', serializeRadio(radios[role]));
}

function emitByteFrame(role, direction, bytesBuffer, note = '') {
  const hex = bytesBuffer.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
  const ascii = bytesBuffer.toString('utf8').replace(/[^\x20-\x7E]/g, '.');
  sendToRenderer('serial:data', {
    role,
    direction,
    hex,
    ascii,
    note,
    timestamp: Date.now()
  });
}

function x25CrcAccumulate(crc, byteValue) {
  let tmp = byteValue ^ (crc & 0xff);
  tmp ^= (tmp << 4) & 0xff;
  return (
    ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
  );
}

function x25Crc(buffer, crcExtra) {
  let crc = 0xffff;
  for (const byteValue of buffer) {
    crc = x25CrcAccumulate(crc, byteValue);
  }
  crc = x25CrcAccumulate(crc, crcExtra);
  return crc;
}

function buildMavlinkCommandLongRelayPacket(color) {
  const relayIndex = LED_TO_RELAY_INDEX[color] ?? LED_TO_RELAY_INDEX.white;
  const payload = Buffer.alloc(33);

  payload.writeFloatLE(relayIndex, 0); // param1 relay number
  payload.writeFloatLE(1.0, 4);        // param2 relay on
  payload.writeFloatLE(0.0, 8);        // param3
  payload.writeFloatLE(0.0, 12);       // param4
  payload.writeFloatLE(0.0, 16);       // param5
  payload.writeFloatLE(0.0, 20);       // param6
  payload.writeFloatLE(0.0, 24);       // param7
  payload.writeUInt16LE(MAVLINK_COMMAND_DO_SET_RELAY, 28);
  payload.writeUInt8(0, 30);           // target_system (broadcast)
  payload.writeUInt8(0, 31);           // target_component (broadcast)
  payload.writeUInt8(0, 32);           // confirmation

  const header = Buffer.from([
    0xfe,
    payload.length,
    mavlinkSequence,
    MAVLINK_SYSTEM_ID_GCS,
    MAVLINK_COMPONENT_ID_GCS,
    MAVLINK_MSG_ID_COMMAND_LONG
  ]);

  mavlinkSequence = (mavlinkSequence + 1) & 0xff;

  const crcInput = Buffer.concat([header.subarray(1), payload]);
  const crc = x25Crc(crcInput, MAVLINK_COMMAND_LONG_CRC_EXTRA);
  const checksum = Buffer.from([crc & 0xff, (crc >> 8) & 0xff]);

  return Buffer.concat([header, payload, checksum]);
}

function parseMavlinkFrames(role, bytes) {
  const radio = radios[role];
  if (!radio) {
    return;
  }

  const previous = Buffer.isBuffer(radio.mavlinkRxBuffer) ? radio.mavlinkRxBuffer : Buffer.alloc(0);
  let buffer = Buffer.concat([previous, bytes]);

  while (buffer.length >= 8) {
    const stxIndex = buffer.indexOf(0xfe);
    if (stxIndex === -1) {
      buffer = Buffer.alloc(0);
      break;
    }

    if (stxIndex > 0) {
      buffer = buffer.subarray(stxIndex);
    }

    if (buffer.length < 8) {
      break;
    }

    const payloadLength = buffer[1];
    const frameLength = 6 + payloadLength + 2;
    if (buffer.length < frameLength) {
      break;
    }

    const frame = buffer.subarray(0, frameLength);
    buffer = buffer.subarray(frameLength);

    const msgId = frame[5];
    if (msgId !== MAVLINK_MSG_ID_COMMAND_LONG || payloadLength !== 33) {
      continue;
    }

    const payload = frame.subarray(6, 6 + payloadLength);
    const command = payload.readUInt16LE(28);
    if (command !== MAVLINK_COMMAND_DO_SET_RELAY) {
      continue;
    }

    const relayIndex = Math.round(payload.readFloatLE(0));
    const mappedColor = RELAY_INDEX_TO_COLOR[relayIndex];
    if (mappedColor) {
      sendToRenderer('radio:commandReceived', {
        role,
        color: mappedColor,
        timestamp: Date.now()
      });
    }
  }

  radio.mavlinkRxBuffer = buffer;
}

function attachRadioPortHandlers(role, port) {
  const radio = radios[role];

  port.on('data', (chunk) => {
    markPortActivity(port);
    const bytes = Buffer.from(chunk);
    parseMavlinkFrames(role, bytes);
    emitByteFrame(role, 'rx', bytes);
  });

  port.on('error', () => {
    void disconnectRadio(role);
  });

  port.on('close', () => {
    if (radio.port) {
      radio.port = null;
      radio.connected = false;
      radio.path = '';
      radio.atMode = false;
      radio.mavlinkRxBuffer = Buffer.alloc(0);
      emitRadioStatus(role);
    }
  });
}

async function connectRadio(role, portPath) {
  const radio = radios[role];
  if (!radio) {
    throw new Error('Unknown radio role.');
  }

  if (radio.connected && radio.path === portPath) {
    return serializeRadio(radio);
  }

  if (radio.port) {
    await disconnectRadio(role);
  }

  const port = new SerialPort({
    path: portPath,
    baudRate: 57600,
    autoOpen: false
  });

  await new Promise((resolve, reject) => {
    port.open((error) => {
      if (error) {
        reject(error);
        return;
      }
      markPortActivity(port);
      resolve(undefined);
    });
  });

  radio.port = port;
  radio.connected = true;
  radio.path = portPath;
  radio.atMode = false;
  radio.mavlinkRxBuffer = Buffer.alloc(0);

  try {
    radio.stats = await queryRadioStats(port, role);
    if (typeof radio.stats?.dutyCycle === 'number') {
      radio.dutyCycle = radio.stats.dutyCycle;
      radio.mode = modeFromDutyCycle(radio.dutyCycle);
    }
  } catch {
    radio.stats = null;
  }

  attachRadioPortHandlers(role, port);

  emitRadioStatus(role);

  return serializeRadio(radio);
}

async function disconnectRadio(role) {
  const radio = radios[role];
  if (!radio || !radio.port) {
    radio.connected = false;
    radio.path = '';
    emitRadioStatus(role);
    return serializeRadio(radio);
  }

  const port = radio.port;
  radio.port = null;

  await new Promise((resolve) => {
    if (!port.isOpen) {
      resolve(undefined);
      return;
    }
    port.close(() => resolve(undefined));
  });

  radio.connected = false;
  radio.path = '';
  radio.atMode = false;
  radio.stats = null;
  radio.mavlinkRxBuffer = Buffer.alloc(0);
  emitRadioStatus(role);
  return serializeRadio(radio);
}

async function refreshRadioStats(role) {
  const radio = radios[role];
  if (!radio || !radio.port || !radio.port.isOpen) {
    throw new Error('Radio is not connected.');
  }

  const portPath = radio.path;
  await disconnectRadio(role);
  return connectRadio(role, portPath);
}

async function ensurePreferredConnections(settings) {
  const ports = await listPortsSafe();
  const byPath = new Set(ports.map((port) => port.path));

  for (const role of ['left', 'right']) {
    const preferred = settings.preferredPorts[role];
    if (preferred && byPath.has(preferred) && !radios[role].connected) {
      try {
        await connectRadio(role, preferred);
      } catch {
        // Ignore auto-connect failures and keep trying as devices appear.
      }
    }
  }
}

async function uploadFirmware(role, portPath) {
  const radio = radios[role];
  const selectedPortPath = portPath || radio.path;

  if (!selectedPortPath) {
    throw new Error('Select a USB port before uploading firmware.');
  }

  const { firmwareDir, uploaderPath, firmwarePath } = getFirmwarePaths();

  if (!fs.existsSync(uploaderPath)) {
    throw new Error(`Uploader script not found: ${uploaderPath}`);
  }

  if (!fs.existsSync(firmwarePath)) {
    throw new Error(`Firmware image not found: ${firmwarePath}`);
  }

  if (radio.port) {
    await disconnectRadio(role);
  }

  const { stdout, stderr } = await execFileAsync(
    'python3',
    [uploaderPath, '--port', selectedPortPath, firmwarePath],
    {
      cwd: firmwareDir,
      maxBuffer: 1024 * 1024
    }
  );

  return {
    ok: true,
    portPath: selectedPortPath,
    firmwarePath,
    output: [stdout, stderr].filter(Boolean).join('\n').trim()
  };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 1080,
    minWidth: 1100,
    minHeight: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const distPath = getRendererDistPath();
  const hasLocalBuild = fs.existsSync(distPath);
  const useDevServer = !app.isPackaged && await canConnectToDevServer(rendererUrl);

  if (useDevServer) {
    await mainWindow.loadURL(rendererUrl);
  } else if (hasLocalBuild) {
    await mainWindow.loadFile(distPath);
  } else {
    throw new Error('Renderer build not found. Run npm run build or npm run dev in Broadcast/.');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const settings = readSettings();
  radios.left.dutyCycle = settings.dutyCycles.left;
  radios.right.dutyCycle = settings.dutyCycles.right;
  radios.left.mode = modeFromDutyCycle(radios.left.dutyCycle);
  radios.right.mode = modeFromDutyCycle(radios.right.dutyCycle);

  await createWindow();
  await ensurePreferredConnections(settings);

  portPollTimer = setInterval(async () => {
    const ports = await listPortsSafe();
    sendToRenderer('ports:changed', ports.map(normalizePort));
    await ensurePreferredConnections(readSettings());
  }, 2000);
});

app.on('window-all-closed', async () => {
  if (portPollTimer) {
    clearInterval(portPollTimer);
    portPollTimer = null;
  }

  await Promise.all([disconnectRadio('left'), disconnectRadio('right')]);

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:init', async () => {
  const settings = readSettings();
  const ports = (await listPortsSafe()).map(normalizePort);

  return {
    ports,
    radios: {
      left: serializeRadio(radios.left),
      right: serializeRadio(radios.right)
    },
    preferredPorts: settings.preferredPorts
  };
});

ipcMain.handle('ports:list', async () => {
  return (await listPortsSafe()).map(normalizePort);
});

ipcMain.handle('radio:connect', async (_event, role, portPath) => {
  const radioRole = role === 'right' ? 'right' : 'left';
  return connectRadio(radioRole, portPath);
});

ipcMain.handle('radio:disconnect', async (_event, role) => {
  const radioRole = role === 'right' ? 'right' : 'left';
  return disconnectRadio(radioRole);
});

ipcMain.handle('radio:refreshStats', async (_event, role) => {
  const radioRole = role === 'right' ? 'right' : 'left';
  return refreshRadioStats(radioRole);
});

ipcMain.handle('settings:setPreferredPort', async (_event, role, portPath) => {
  const radioRole = role === 'right' ? 'right' : 'left';
  const settings = readSettings();
  settings.preferredPorts[radioRole] = portPath;
  writeSettings(settings);
  return settings.preferredPorts;
});

ipcMain.handle('radio:setDutyCycle', async (_event, role, dutyCycleValue) => {
  const radioRole = role === 'right' ? 'right' : 'left';
  const nextDuty = Math.max(0, Math.min(100, Number(dutyCycleValue) || 0));

  const settings = readSettings();
  settings.dutyCycles[radioRole] = nextDuty;
  writeSettings(settings);

  const radio = radios[radioRole];
  radio.dutyCycle = nextDuty;
  radio.mode = modeFromDutyCycle(nextDuty);
  if (radio.stats) {
    radio.stats.dutyCycle = nextDuty;
  }
  emitRadioStatus(radioRole);

  const sRegisterDutyCycle = 11;
  const command = Buffer.from(`ATS${sRegisterDutyCycle}=${nextDuty}\n`, 'utf8');
  if (radio.port && radio.port.isOpen) {
    let atSession = null;
    try {
      atSession = await ensureAtMode(radio.port, radioRole);
      const dutyOutput = await sendAtCommand(radio.port, `ATS${sRegisterDutyCycle}=${nextDuty}`, {
        timeoutMs: 1400,
        idleMs: 300,
        leadingBreak: false
      });

      emitStatsDebug(radioRole, 'ATS11 response received.', {
        raw: { dutyCycleOutput: escapeForLog(dutyOutput) }
      });

      if (!dutyOutput.toUpperCase().includes('OK')) {
        throw new Error('Radio did not acknowledge DUTY_CYCLE S-register update in AT mode.');
      }

      const saveOutput = await sendAtCommand(radio.port, 'AT&W', {
        timeoutMs: 1400,
        idleMs: 300,
        leadingBreak: false
      });

      emitStatsDebug(radioRole, 'AT&W save response received.', {
        raw: { saveOutput: escapeForLog(saveOutput) }
      });

      if (!saveOutput.toUpperCase().includes('OK')) {
        throw new Error('Radio did not acknowledge parameter save (AT&W).');
      }
    } finally {
      if (atSession) {
        try {
          await exitAtMode(radio.port, radioRole);
        } catch (exitError) {
          const message = exitError instanceof Error ? exitError.message : 'Unknown ATO exit error.';
          emitStatsDebug(radioRole, `Failed to exit AT mode cleanly after duty update: ${message}`);
        }
      }
    }

    emitByteFrame(radioRole, 'tx', command, 'duty-cycle-update');
  }

  return serializeRadio(radio);
});

ipcMain.handle('radio:sendLed', async (_event, color) => {
  const safeColor = ['red', 'blue', 'green', 'white'].includes(color) ? color : 'white';
  const payload = buildMavlinkCommandLongRelayPacket(safeColor);
  const leftRadio = radios.left;
  const rightRadio = radios.right;

  if (!leftRadio.port || !leftRadio.port.isOpen) {
    throw new Error('Broadcast radio is not connected.');
  }

  if (leftRadio.mode !== 'broadcast') {
    throw new Error('Broadcast radio must have DUTY_CYCLE=100 to send broadcast LED commands.');
  }

  if (leftRadio.atMode) {
    emitStatsDebug('left', 'Broadcast radio is in AT mode; exiting to data mode before LED send.');
    await exitAtMode(leftRadio.port, 'left');
  }

  if (rightRadio.port && rightRadio.port.isOpen && rightRadio.atMode) {
    emitStatsDebug('right', 'Receiver radio is in AT mode; exiting to data mode before LED send.');
    await exitAtMode(rightRadio.port, 'right');
  }

  await writeToPort(leftRadio.port, payload);
  emitByteFrame('left', 'tx', payload, `led-${safeColor}`);

  return { ok: true };
});

ipcMain.handle('radio:uploadFirmware', async (_event, role, portPath) => {
  const radioRole = role === 'right' ? 'right' : 'left';
  return uploadFirmware(radioRole, portPath);
});
