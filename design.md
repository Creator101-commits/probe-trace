# ProbeTrace Architecture & Design Document

ProbeTrace is a high-performance desktop application for hardware protocol sniffing, analysis, and packet injection. It is built using **Tauri** (Rust backend for hardware access and high performance) and **React** (Frontend for a fluid, responsive UI).

---

## 1. Core UI Layout

The application utilizes a 3-column resizable layout (powered by `react-resizable-panels`) to maximize screen real estate while keeping all critical tools accessible.

### **Left Panel: Connection & Session Management**
- **Protocol Tabs**: Switch between UART, SPI, I2C, and USB modes.
- **Hardware Configuration**: 
  - Port selector (auto-detects connected USB/Serial devices).
  - UART config: Baud rate, Data Bits, Parity, Stop Bits.
  - SPI config: Pin mappings (MOSI, MISO, CLK, CS) and SPI Mode.
- **Capture Controls**: Start/Stop capture buttons with dynamic status indicators.
- **History Viewer**: A list of past captures loaded from the SQLite database, allowing one-click reloading of historical sessions.

### **Middle Panel: Live Data Stream & Visualization**
- **Toolbar**: 
  - Quick filters (Direction: TX/RX, Anomalies Only).
  - Search bar for regex/pattern matching.
  - View toggle (Packet Table vs. Waveform).
- **Virtualized Packet Table**: 
  - Extremely fast rendering of thousands of rows using `@tanstack/react-virtual`.
  - Columns: ID, Timestamp, Direction, Length, Hex Bytes, ASCII preview.
  - Color-coding: Rows highlight red for anomalies/alerts, blue/green/teal depending on protocol and direction (e.g., MOSI vs MISO).
- **Timing Waveform (Optional View)**: A canvas-based logic analyzer view showing the temporal spacing between packets.

### **Right Panel: Intelligence, Decoders & Injection**
- **Live Decoders**:
  - Automatically translates raw bytes into human-readable formats based on the selected or auto-detected protocol (e.g., NMEA GPS coordinates, Modbus Registers, AT Commands).
- **Anomaly & Alert Engine**:
  - Displays detected anomalies (e.g., I2C NACKs, CRC failures).
  - Configurable Alert Rules: Users can set patterns, thresholds, or delays that trigger UI highlights, audio beeps, or desktop notifications.
- **Packet Injector & Scripting**:
  - Hex editor for manual packet crafting.
  - Send button to transmit custom bytes to the connected device.
  - Replay controls to play back a captured session at variable speeds.

---

## 2. Backend Architecture (Rust/Tauri)

The Rust backend handles all heavy lifting to ensure the UI thread never blocks during high-speed captures.

- **Capture Engine (`src/capture/`)**: Uses the `serialport` crate to interface with USB-to-TTL adapters or hardware bridges (like an Arduino sniffer). It reads bytes continuously in a dedicated thread.
- **Database (`src/db.rs`)**: Uses SQLite to persist capture metadata and raw packet streams instantly, allowing the app to handle millions of packets without running out of RAM.
- **Analysis & Baseline (`src/analysis/`)**: 
  - Builds statistical baselines during the first few seconds of a capture (e.g., average packet delay, expected lengths).
  - Flags statistical deviations as anomalies.
- **Export System (`src/replay/export.rs`)**: Packages SQLite data into portable formats (.pcap for Wireshark, .csv for Excel, .html for sharing).

---

## 3. Styling & Theme System

ProbeTrace employs a modern, "calm" aesthetic built entirely with **Tailwind CSS v4**.

- **Dark Mode (Default)**: Uses a premium Zinc/Slate palette (e.g., `#18181b` app background, `#27272a` panels) rather than harsh high-contrast blacks. Text uses soft grays (`#f4f4f5`).
- **Light Mode**: Clean pure white panels (`#ffffff`) over a soft off-white canvas (`#f4f4f5`) with delicate gray borders.
- **Typography**: Uses the `Inter` font stack for maximum legibility of dense hex and ASCII data.
- **Accessibility**: Micro-animations on hover, distinct iconography (via Lucide React), and customizable font sizes for the packet table.

---

## 4. Key Workflows

1. **Auto-Detect**: If a user plugs in a GPS module and hits "Capture", the backend analyzes the first 15 packets, recognizes NMEA sentence structures, and automatically spins up the NMEA decoder in the Right Panel.
2. **Replay & Inject**: A user captures 10 minutes of traffic from a sensor. They disconnect the sensor, load the capture from History, and hit "Replay" to inject those exact same bytes back into the master device to simulate the sensor.
3. **Alerting**: The user writes a custom rule: "If packet contains ASCII 'ERROR', play a beep and highlight the row red." They can then walk away from the computer and listen for faults.
