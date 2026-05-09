# SiK Broadcast Console

Desktop app for macOS and Windows to manage two USB-connected SiK radios side by side.

- Left panel: broadcast radio control and LED MAVLink command send.
- Right panel: receive radio monitor with command flash indicators.
- DUTY_CYCLE logic:
  - `100` => broadcast mode
  - `0` => receive mode
  - any other value => peer (legacy 1:1 behavior)
- Byte stream view:
  - Left panel shows transmitted bytes (TX)
  - Right panel shows received bytes (RX)
- Saved USB preference and auto-connect by saved port path.

## Tech Stack

- Electron (main + preload)
- React + TypeScript + Vite (renderer)
- `serialport` for USB serial communication

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Package Desktop Installers

```bash
npm run package
```

This builds installer targets for macOS and Windows via Electron Builder.

## Notes

- LED command payloads are scaffolded as byte frames (`LED_RED`, `LED_BLUE`, `LED_GREEN`, `LED_WHITE`) and can be replaced with full MAVLink packets.
- Receiver command flash is triggered by received payload parsing and mirrored preview events for immediate operator feedback.
