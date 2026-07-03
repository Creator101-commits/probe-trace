# ProbeTrace

> A real-time hardware protocol analyzer for capturing, inspecting, and decoding serial communication.

![License](https://img.shields.io/github/license/user/probetrace)
![Vite](https://img.shields.io/badge/Vite-7.x-646CFF.svg)
![React](https://img.shields.io/badge/React-19.x-61DAFB.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8D8.svg)
![Rust](https://img.shields.io/badge/Rust-1.75+-000000.svg)

ProbeTrace is a high-performance desktop hardware protocol analyzer designed with Tauri 2, Rust, and React. It captures real hardware protocol traffic in real time, buffers packets in memory, archives sessions in SQLite, and visualizes them instantly via a high-performance virtualized packet viewer and a low-level hex inspector.

## Features & Protocol Support

- **UART Capture**: Asynchronous serial line capture with configurable baud rates, data bits, parity, and stop bits.
- **SPI Capture**: Multi-channel logic analyzer decoding supporting active-low CS framing, bit sampling per clock edge according to modes 0–3, and customizable bit order (MSB/LSB).
- **I2C Capture**: Two-line logic capture (SDA + SCL) decoding start/stop conditions, 7-bit addressing, R/W directions, and byte acknowledgments. Detects errors like address NACKs, data NACKs, and clock-stretching timeouts.
- **Protocol Auto-Detection**: Analyzes UART traffic patterns (first 256 bytes) using custom heuristics to detect:
  - **AT Commands**: Searches for `AT`, `OK`, `ERROR` patterns.
  - **NMEA GPS**: Matches `$GP`, `$GN` strings and field structures.
  - **Modbus RTU**: Validates CRC-16 checksums and function codes.
  - **MIDI**: Detects MIDI status bytes and channel messages.
  - **Raw binary**: Flags non-printable data.
- **Color-Coded Visuals**: Instantly identify packet protocols and streams (UART is blue, SPI MOSI is green, SPI MISO is teal, I2C Write is orange, I2C Read is yellow).
- **Direction & Anomaly Filters**: Quickly filter packets by `All`, `TX only`, `RX only`, or display `Anomalies Only` to isolate errors.
- **Statistical Baseline & Anomaly Detection**:
  - Automatically profiles the first 30 seconds of a capture to build a baseline (`mean`, `std_dev`, `min`, `max`, `percentile_95`).
  - Flags Timing deviations (> 3 SDs), Length anomalies, I2C Address/Data NACKs, Modbus CRC errors, Duplicate transmissions (< 100ms), and Garbled UART data.
- **Configurable Alert Engine**:
  - Form editor to add, edit, or delete customized alert rules (regex, length matching, byte values at offset, delay timeouts, error rates).
  - Actions include desktop notifications, red highlighting of packet rows, Web Audio API status alerts, and chronological logs.

## Table of Contents

- [ProbeTrace](#probetrace)
  - [Features & Protocol Support](#features--protocol-support)
  - [Table of Contents](#table-of-contents)
  - [Quickstart / Demo](#quickstart--demo)
  - [Installation](#installation)
  - [Usage](#usage)
  - [Architecture](#architecture)
  - [Development](#development)
  - [Release Version History](#release-version-history)
  - [Contributing](#contributing)
  - [License](#license)

## Quickstart / Demo
[(Back to top)](#table-of-contents)

ProbeTrace opens an asynchronous connection with serial UART/logic analyzer devices or simulated mock devices to monitor protocol data streams.
- **Top Bar Tab Bar**: Switch between UART, SPI, I2C, and USB captures to expose relevant connection controls (channel selections, modes, etc.).
- **Auto-Detection Banner**: Shows a prompt when NMEA, AT commands, or Modbus data is auto-detected, allowing users to apply custom protocol decoders.
- **Left Sidebar**: View active device specifications and load past saved captures from the database.
- **Main View**: Wireshark-style scrolling grid showing time, packet indices, protocol types, direction, hex byte representation, and ASCII.
- **Bottom Panel**: High-fidelity hex inspector with detailed decoded telemetry for selected logic frames (I2C address/ACK status/errors or SPI MOSI vs MISO).
- **Right Sidebar**: Decoded protocol logging terminal.

## Installation
[(Back to top)](#table-of-contents)

**macOS & Linux**

Ensure you have Rust and Node.js installed on your machine.
```sh
# Clone and install dependencies
git clone https://github.com/user/ProbeTrace.git
cd ProbeTrace
npm install
```

**Windows**

For Windows setups, the dependencies compile natively with MSVC build tools.
```sh
npm install
```

## Usage
[(Back to top)](#table-of-contents)

To launch the desktop application in developer mode:

```sh
npm run tauri dev
```

To compile a native production release bundle:

```sh
npm run tauri build
```

## Architecture
[(Back to top)](#table-of-contents)

ProbeTrace splits operations between a high-efficiency Rust backend and a reactive TypeScript/React frontend:

1. **Rust Logic Decoders**: Performs real-time sample processing on separate threads for UART, SPI (CS, Clock, and mode sampling), and I2C (Start/Stop, SDA, SCL transitions).
2. **SQLite State Archiver**: Saves captures and packet logs incrementally into a local database (`probetrace.db`) via `rusqlite`.
3. **Tauri Emitter**: Pushes captured packets instantly via events to the webview.
4. **Virtualized UI**: Uses `@tanstack/react-virtual` to display millions of rows with minimal memory overhead.

## Development
[(Back to top)](#table-of-contents)

Set up a local development workspace:

```sh
# Start development server
npm run tauri dev
```

## Release Version History

### [v0.5.0] - Day 5: Statistical Baseline, Anomaly Detection & Alerting (Current)
* **Statistical Baseline**: Built `src-tauri/src/analysis/baseline.rs` to profile the first 30 seconds of capturing for UART (inter-arrival time, packet length, byte distribution), I2C (typical transaction length, ACK patterns), and SPI. Computes statistical baseline statistics in memory (`mean`, `std_dev`, `min`, `max`, `percentile_95`).
* **Anomaly Detection Backend**: Developed detectors in `src-tauri/src/analysis/anomalies.rs` flagging timing anomalies (delays > 3 standard deviations), packet length changes, I2C address/data NACKs, Modbus CRC mismatches, duplicate packet detection (identical payload within 100ms), and garbled UART character data (non-printable ratio > 30%).
* **Alert Engine & Rules Editor**: Built `src/alerts/AlertEngine.ts` matching rule criteria (regex strings, length thresholds, byte offset matches, inactivity timeouts, error rates) and firing custom alert actions: plays beeps via Web Audio API, fires OS desktop notifications, highlights packet rows in red, and logs to a separate Alerts Panel.
* **Frontend Panels**: Added an Anomaly summary sidebar counting errors with most-frequent highlight, warning/error badges in the packet row list, a chronological Fired Alerts log panel (click to jump to matching packet), and an "Anomalies only" filter toggle.

### [v0.4.0] - Day 4: Timing Diagram & Logic Analyzer Viewer
* **Timing Engine**: Built `src/timing/TimingEngine.ts` to manage high-fidelity logic transitions `{t, v}` and viewport calculations. Contains serializers converting packet payload byte buffers into visual UART, SPI (CS/CLK/MOSI/MISO), and I2C (SDA/SCL) signal transitions.
* **Waveform Canvas**: Developed `src/timing/WaveformCanvas.tsx` using HTML `<canvas>` to render multi-channel timing diagrams. Supports color-coded protocol highlights (UART byte periods labeled in ASCII, SPI MOSI/MISO/CLK/CS, I2C start/stop triangles and address/data packets).
* **Zoom & Pan**: Implemented mouse-centered zoom (preserving timeline position under cursor), scrollwheel scaling, click-and-drag panning, and time-range selection with "Zoom to Selection" and "Fit All" controls.
* **Measurement Cursors**: Features Marker A & B time rulers reporting timestamps, $\Delta T$ delta time, and calculated frequency ($1/\Delta T$). Supports right-click context menus for Auto-Measuring pulse periods/frequencies and UART Baud Rate auto-detection.
* **Bidirectional Linking**: Connects the packet grid and timeline; clicking a packet centers the waveform at its timestamp, while clicking waveform decodes selects the matching packet in the table.

### [v0.3.0] - Day 3: Deep Protocol Decoders & Visualizations
* **NMEA GPS Decoder**: Detects sentences starting with `$` and ending with `*XX` checksum. Performs XOR checksum validation. Parses `$GPRMC` (time, status, lat, lon, knots, course, date), `$GPGGA` (fix quality, satellites, altitude, HDOP), `$GPGSV` (satellites in view, elevation, azimuth, SNR), and `$GPVTG` (track made good, speed). Visualizes live GPS position on a mini SVG world map.
* **Modbus RTU Decoder**: Parses Modbus RTU frames (device address, function code, variable data, CRC16). Implements standard Modbus CRC16 polynomial `0xA001` from scratch. Decodes function codes `01`, `02`, `03`, `04`, `05`, `06`, `0F`, and `10`. Keeps a live updated register table for holding and input registers.
* **AT Command Decoder**: Decodes AT syntax variants (`AT+CMD=val`, `AT+CMD?`, `AT+CMD=?`, bare `ATD`, etc.). Includes a built-in database for GSM/SIM800, ESP8266, and Bluetooth HC-05 modules. Matches responses (`OK`, `ERROR`, `+CME ERROR`) back to commands.
* **Frontend Decoder Panel**: Added right panel decoder view with dropdown selector (None / NMEA / Modbus RTU / AT Commands / Raw Hex). Displays fully decoded frames with labeled fields, values, validity indicators, and live visualizations (SVG world map plotting coordinate tracking, live register table updating).

### [v0.2.0] - Day 2: SPI/I2C Capture & Protocol Auto-Detection
* **SPI Capture Support**: Developed real-time logic analyzer bitstream decoder for active-low CS framing, modes 0–3 (CPOL/CPHA configurations), and MSB/LSB bit order. Includes a live mock SPI simulator generating `"HELLO SPI DATA SENT"` and `"WORLD SPI RESPONSE "` frames.
* **I2C Capture Support**: Implemented two-wire SDA/SCL logic decoder parsing START/STOP transitions, 7-bit addresses, R/W direction, and ACK/NACK flags. Detects address NACK, data NACK, and clock-stretching timeouts. Includes a mock EEPROM writer simulator.
* **Protocol Auto-Detection**: Analyzes the first 256 bytes of UART captures using statistical and structural heuristics to identify AT Commands, NMEA GPS data, Modbus RTU, MIDI, or raw binary. Exposes tauri endpoints to scoring logic.
* **UI enhancements**: Exposes tabbed selectors for UART/SPI/I2C controls, direction filters (All/TX/RX), color-coding rules (UART=blue, SPI MOSI=green, SPI MISO=teal, I2C write=orange, I2C read=yellow), and custom telemetry inspector details.

### [v0.1.0] - Day 1: Project Foundation & UART Capture
* **Project Setup**: Scaffolded Tauri 2 app with React/TypeScript, styled using Tailwind CSS, and registered crate dependencies.
* **UART Capture Engine**: Integrates `serialport` streaming thread mapping bytes to individual `Packet` structures and emitting them live to the webview.
* **SQLite Storage**: Implemented `Db` manager with captures and packets logging schema to persist and retrieve analyzer history.
* **Virtualized UI & Hex Inspector**: Integrated `@tanstack/react-virtual` for high-throughput packet lists, complete with a classic offset-based hex inspector.

## Contributing
[(Back to top)](#table-of-contents)

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazingFeature`)
3. Commit your changes (`git commit -m 'Add amazing new feature'`)
4. Push to the branch (`git push origin feature/amazingFeature`)
5. Open a Pull Request

## License
[(Back to top)](#table-of-contents)

Distributed under the MIT License. See `LICENSE` for details.
