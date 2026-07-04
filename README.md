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
- **Traffic Replay Engine**: Replay saved captures back to a device, control replay speed multiplier (0.5x, 1x, 2x, 5x, 10x, instant), and filter by direction or match patterns.
- **Manual Packet Injector**: Input raw bytes in hex format, view live ASCII preview, trigger repeat sending loops with delays, manage presets, and auto-correlate/highlight likely response packets.
- **QuickJS JavaScript Scripting Engine**: Code script sequences in a Monaco Editor. Use APIs: `probe.send()`, `probe.wait()`, `probe.waitForPacket()`, `probe.assert()`, and `probe.log()`. Built-in presets: I2C Address Probe, Modbus Registers Scanner, and UART Echo Loopback validator.
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

### [v0.7.0] - Day 7: Export Formats, UI Polishing & Optimization (Current)
* **Export Formats**: Implemented exporting/importing to `.ptrace`, CSV, PCAP (Wireshark DLT_USER), and HTML reports.
* **Resizable Panel Layout**: Integrated `react-resizable-panels` layout (Left Connection, Middle Grid, Right Telemetry) with dynamic boundaries.
* **Calm Theme Customization**: Swapped high-contrast themes for Slate/Zinc colors. Added light-mode toggle, text sizing, and custom columns.
* **Alert Logic Stabilization**: Muted beeps and desktop notifications by default to prevent fatigue.
* **Global Keyboard Shortcuts**: Space toggles capture, Cmd/Ctrl+F focuses filter, Cmd/Ctrl+E/R/W handle panels and waveforms.
* **Zero-Warning Rust Compiling**: Resolved 8 Rust warnings across analyzer and decoder crates.

### [v0.6.0] - Day 6: Traffic Replay, Packet Injection & Scripting Automation
* **Traffic Replay Engine**: Replay SQLite captures over serial ports with accurate timing, custom speed multipliers, and filter rules.
* **Manual Packet Injector**: Added raw hex injector interface, loop transmission, custom presets, and response tracing.
* **JavaScript Scripting Engine**: Integrated Monaco Editor with QuickJS runtime supporting async API hooks (`probe.send`, `probe.wait`, `probe.waitForPacket`).
* **Built-in Scripts**: Ships with scanner templates for I2C addresses, Modbus registers, and UART loopback loops.

### [v0.5.0] - Day 5: Statistical Baseline, Anomaly Detection & Alerting
* **Statistical Baseline**: Profile capture timing and lengths during first 30 seconds to generate a metrics baseline.
* **Anomaly Detection**: Flags delays (>3 SDs), length errors, I2C NACKs, Modbus CRC errors, and duplicate data.
* **Alert Engine**: Customizable rule editor triggering highlights, Web Audio beeps, and system alerts.
* **Frontend Panels**: Added error-summary badges, filter toggles, and dedicated Alerts and Anomaly panels.

### [v0.4.0] - Day 4: Timing Diagram & Logic Analyzer Viewer
* **Timing Engine**: Serializes bytes into physical transition streams for UART, SPI, and I2C signals.
* **Waveform Canvas**: Renders high-fidelity, scrollable multi-channel protocol timing diagrams on HTML5 `<canvas>`.
* **Zoom & Pan**: Supports mouse-wheel zoom, drag-to-pan, and fit-all timeline view scaling.
* **Measurement Cursors**: A/B timeline rulers reporting delta time, frequency, and custom baud rate metrics.
* **Bidirectional Linking**: Syncs selected packet index between waveform canvas and virtualized packet table.

### [v0.3.0] - Day 3: Deep Protocol Decoders & Visualizations
* **NMEA GPS Decoder**: Parses GPS strings ($GPRMC, $GPGGA, $GPGSV, $GPVTG) and plots tracking route on dynamic SVG world map.
* **Modbus RTU Decoder**: Decodes standard register reads/writes, calculates CRC16, and maintains a live holding register table.
* **AT Command Decoder**: Decodes AT dial, read, write, and command queries against a built-in cellular/Wi-Fi chip database.
* **Frontend Decoder Panel**: Rendered telemetry inspectors, register maps, and GPS routing.

### [v0.2.0] - Day 2: SPI/I2C Capture & Protocol Auto-Detection
* **SPI Capture Support**: Sniffs SPI lines sampling modes 0–3 with custom bit ordering (MSB/LSB) and active-low CS framing.
* **I2C Capture Support**: Sniffs SDA/SCL lines decoding address, read/write bit, and start/stop flags.
* **Protocol Auto-Detection**: Analyzes first 256 bytes using heuristics to auto-detect and score UART protocol types.
* **UI Enhancements**: Added protocol filter toggles and detail inspectors.

### [v0.1.0] - Day 1: Project Foundation & UART Capture
* **Project Setup**: Scaffolded Tauri v2 workspace with React, Tailwind CSS, and Rust backend crates.
* **UART Capture Engine**: Integrated multi-threaded serialport buffer capture backend.
* **SQLite Storage**: Implemented localized database storage schema.
* **Virtualized UI**: Rendered scrolling tables using `@tanstack/react-virtual` alongside a low-level hex reader.

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
