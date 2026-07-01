export interface Transition {
  t: number; // timestamp in ns
  v: 0 | 1;  // value (0 or 1)
}

export interface DecodedPeriod {
  startTime_ns: number;
  endTime_ns: number;
  label: string;
  type: "uart_byte" | "spi_mosi" | "spi_miso" | "i2c_addr" | "i2c_data" | "i2c_start" | "i2c_stop";
}

export interface WaveformData {
  transitions: Record<string, Transition[]>;
  decodedPeriods: Record<string, DecodedPeriod[]>;
}

export interface Viewport {
  startTime_ns: number;
  endTime_ns: number;
  pixelsPerNs: number;
}

export interface BitEvent {
  channel_name: string;
  timestamp_ns: number;
  value: 0 | 1;
}

/**
 * Timing Engine class to manage waveform data and viewport math.
 */
export class TimingEngine {
  /**
   * Builds transitions from raw bit-level events.
   */
  static buildWaveformDataFromEvents(events: BitEvent[]): Record<string, Transition[]> {
    const data: Record<string, Transition[]> = {};
    
    // Group events by channel
    for (const ev of events) {
      if (!data[ev.channel_name]) {
        data[ev.channel_name] = [];
      }
      data[ev.channel_name].push({ t: ev.timestamp_ns, v: ev.value });
    }

    // Sort transitions for each channel
    for (const channel of Object.keys(data)) {
      data[channel].sort((a, b) => a.t - b.t);
      // Remove consecutive duplicates
      const unique: Transition[] = [];
      let prevValue: number | null = null;
      for (const t of data[channel]) {
        if (t.v !== prevValue) {
          unique.push(t);
          prevValue = t.v;
        }
      }
      data[channel] = unique;
    }

    return data;
  }

  /**
   * Filters and maps transitions to pixel coordinates for the current viewport.
   */
  static getTransitionsInView(
    transitions: Transition[],
    viewport: Viewport
  ): { x: number; v: 0 | 1; t: number }[] {
    if (!transitions || transitions.length === 0) return [];

    const { startTime_ns, endTime_ns, pixelsPerNs } = viewport;
    const result: { x: number; v: 0 | 1; t: number }[] = [];

    // Find the state just before the viewport starts (so we draw a continuous line from the left edge)
    let initialIndex = -1;
    for (let i = 0; i < transitions.length; i++) {
      if (transitions[i].t <= startTime_ns) {
        initialIndex = i;
      } else {
        break;
      }
    }

    if (initialIndex !== -1) {
      const trans = transitions[initialIndex];
      result.push({
        x: 0,
        v: trans.v,
        t: startTime_ns,
      });
    } else {
      // If there's no transition before, assume default value of 0 or look at the first transition
      result.push({
        x: 0,
        v: transitions[0].v === 1 ? 0 : 1, // opposite of first value as fallback
        t: startTime_ns,
      });
    }

    // Add all transitions inside the viewport
    for (let i = 0; i < transitions.length; i++) {
      const trans = transitions[i];
      if (trans.t > startTime_ns && trans.t <= endTime_ns) {
        const x = (trans.t - startTime_ns) * pixelsPerNs;
        result.push({
          x,
          v: trans.v,
          t: trans.t,
        });
      }
    }

    // Add the first transition after the viewport (to draw the line all the way to the right edge)
    let afterIndex = -1;
    for (let i = 0; i < transitions.length; i++) {
      if (transitions[i].t > endTime_ns) {
        afterIndex = i;
        break;
      }
    }

    if (afterIndex !== -1) {
      const trans = transitions[afterIndex];
      const x = (trans.t - startTime_ns) * pixelsPerNs;
      result.push({
        x,
        v: trans.v,
        t: trans.t,
      });
    } else {
      // If there are no more transitions, continue the last state to the right edge
      const lastVal = result[result.length - 1]?.v ?? 0;
      result.push({
        x: (endTime_ns - startTime_ns) * pixelsPerNs,
        v: lastVal,
        t: endTime_ns,
      });
    }

    return result;
  }

  /**
   * Synthesizes bit-level transitions and decoded periods from packet structures.
   */
  static generateWaveformDataFromPackets(packets: any[]): WaveformData {
    const transitions: Record<string, Transition[]> = {
      UART_TX: [{ t: 0, v: 1 }],
      UART_RX: [{ t: 0, v: 1 }],
      SPI_CS: [{ t: 0, v: 1 }],
      SPI_CLK: [{ t: 0, v: 0 }],
      SPI_MOSI: [{ t: 0, v: 0 }],
      SPI_MISO: [{ t: 0, v: 0 }],
      I2C_SDA: [{ t: 0, v: 1 }],
      I2C_SCL: [{ t: 0, v: 1 }],
    };

    const decodedPeriods: Record<string, DecodedPeriod[]> = {
      UART_TX: [],
      UART_RX: [],
      SPI_MOSI: [],
      SPI_MISO: [],
      I2C_SDA: [],
    };

    // Sort packets by timestamp to process chronologically
    const sortedPackets = [...packets].sort((a, b) => a.timestamp_ns - b.timestamp_ns);

    for (const packet of sortedPackets) {
      const t0 = packet.timestamp_ns;
      const bytes = packet.raw_bytes || [];
      if (bytes.length === 0) continue;

      if (packet.protocol === "UART") {
        const isTx = ["TX", "MOSI", "Write"].includes(packet.direction);
        const channel = isTx ? "UART_TX" : "UART_RX";
        const baud = 115200;
        const bitDuration = 1_000_000_000 / baud; // ~8680 ns

        let currentT = t0;

        for (let i = 0; i < bytes.length; i++) {
          const byteVal = bytes[i];
          const asciiChar = byteVal >= 32 && byteVal <= 126 ? String.fromCharCode(byteVal) : `\\x${byteVal.toString(16).padStart(2, "0")}`;
          const byteStart = currentT;

          // Start bit (0)
          transitions[channel].push({ t: currentT, v: 0 });
          currentT += bitDuration;

          // 8 Data bits (LSB first)
          for (let b = 0; b < 8; b++) {
            const bit = ((byteVal >> b) & 1) as 0 | 1;
            transitions[channel].push({ t: currentT, v: bit });
            currentT += bitDuration;
          }

          // Stop bit (1)
          transitions[channel].push({ t: currentT, v: 1 });
          currentT += bitDuration;

          // Add decoded period
          decodedPeriods[channel].push({
            startTime_ns: byteStart,
            endTime_ns: currentT,
            label: asciiChar,
            type: "uart_byte",
          });
        }
      } else if (packet.protocol === "SPI") {
        // CS goes low
        transitions.SPI_CS.push({ t: t0, v: 0 });

        const bitDuration = 500; // 500ns per half clock (1MHz SPI clock)
        let currentT = t0 + 1000; // start shortly after CS goes low

        for (let i = 0; i < bytes.length; i++) {
          const byteVal = bytes[i];
          // Determine direction
          const isMosi = packet.direction === "MOSI";
          const mosiChannel = "SPI_MOSI";
          const misoChannel = "SPI_MISO";
          const byteStart = currentT;

          // Process 8 bits
          for (let b = 7; b >= 0; b--) {
            const bit = ((byteVal >> b) & 1) as 0 | 1;
            // Write MOSI/MISO data at beginning of clock cycle
            if (isMosi) {
              transitions[mosiChannel].push({ t: currentT, v: bit });
              // mock MISO data with the inverted bits for visual diversity
              transitions[misoChannel].push({ t: currentT, v: (1 - bit) as 0 | 1 });
            } else {
              transitions[misoChannel].push({ t: currentT, v: bit });
              transitions[mosiChannel].push({ t: currentT, v: (1 - bit) as 0 | 1 });
            }

            // Clock rising edge
            transitions.SPI_CLK.push({ t: currentT, v: 0 });
            currentT += bitDuration;
            transitions.SPI_CLK.push({ t: currentT, v: 1 });
            currentT += bitDuration;
          }

          const label = byteVal >= 32 && byteVal <= 126 ? String.fromCharCode(byteVal) : `0x${byteVal.toString(16).toUpperCase().padStart(2, "0")}`;

          decodedPeriods.SPI_MOSI.push({
            startTime_ns: byteStart,
            endTime_ns: currentT,
            label: isMosi ? label : "-",
            type: "spi_mosi",
          });

          decodedPeriods.SPI_MISO.push({
            startTime_ns: byteStart,
            endTime_ns: currentT,
            label: !isMosi ? label : "-",
            type: "spi_miso",
          });
        }

        // Clock returns to idle (0) and CS goes high
        transitions.SPI_CLK.push({ t: currentT, v: 0 });
        currentT += 1000;
        transitions.SPI_CS.push({ t: currentT, v: 1 });
      } else if (packet.protocol === "I2C") {
        const bitDuration = 1250; // 1250ns half clock (400kHz speed)
        let currentT = t0;

        // START Condition: SDA drops while SCL is high
        transitions.I2C_SDA.push({ t: currentT, v: 1 });
        transitions.I2C_SCL.push({ t: currentT, v: 1 });
        
        currentT += bitDuration;
        transitions.I2C_SDA.push({ t: currentT, v: 0 }); // SDA low
        
        currentT += bitDuration;
        transitions.I2C_SCL.push({ t: currentT, v: 0 }); // SCL low

        decodedPeriods.I2C_SDA.push({
          startTime_ns: t0,
          endTime_ns: currentT,
          label: "S",
          type: "i2c_start",
        });

        // Let's assume the first byte is the address if direction is Write/Read, or we simulate address + data
        const isWrite = packet.direction === "Write";
        
        // Simulating: address byte first
        // Let's assume address is 0x50 (commonly EEPROM) or custom
        const addrByte = 0x50;
        const addrStart = currentT;

        // 8 bits of address + RW bit (Write = 0, Read = 1)
        const totalAddrByte = (addrByte << 1) | (isWrite ? 0 : 1);
        for (let b = 7; b >= 0; b--) {
          const bit = ((totalAddrByte >> b) & 1) as 0 | 1;
          transitions.I2C_SDA.push({ t: currentT, v: bit });

          // SCL pulse
          currentT += bitDuration;
          transitions.I2C_SCL.push({ t: currentT, v: 1 });
          currentT += bitDuration;
          transitions.I2C_SCL.push({ t: currentT, v: 0 });
        }

        // ACK bit (SDA driven low by slave)
        transitions.I2C_SDA.push({ t: currentT, v: 0 });
        currentT += bitDuration;
        transitions.I2C_SCL.push({ t: currentT, v: 1 });
        currentT += bitDuration;
        transitions.I2C_SCL.push({ t: currentT, v: 0 });

        decodedPeriods.I2C_SDA.push({
          startTime_ns: addrStart,
          endTime_ns: currentT,
          label: `A:0x${addrByte.toString(16).toUpperCase()} ${isWrite ? "W" : "R"} (ACK)`,
          type: "i2c_addr",
        });

        // Data bytes
        for (let i = 0; i < bytes.length; i++) {
          const byteVal = bytes[i];
          const byteStart = currentT;

          for (let b = 7; b >= 0; b--) {
            const bit = ((byteVal >> b) & 1) as 0 | 1;
            transitions.I2C_SDA.push({ t: currentT, v: bit });

            // SCL pulse
            currentT += bitDuration;
            transitions.I2C_SCL.push({ t: currentT, v: 1 });
            currentT += bitDuration;
            transitions.I2C_SCL.push({ t: currentT, v: 0 });
          }

          // ACK bit
          transitions.I2C_SDA.push({ t: currentT, v: 0 });
          currentT += bitDuration;
          transitions.I2C_SCL.push({ t: currentT, v: 1 });
          currentT += bitDuration;
          transitions.I2C_SCL.push({ t: currentT, v: 0 });

          const label = byteVal >= 32 && byteVal <= 126 ? String.fromCharCode(byteVal) : `0x${byteVal.toString(16).toUpperCase().padStart(2, "0")}`;

          decodedPeriods.I2C_SDA.push({
            startTime_ns: byteStart,
            endTime_ns: currentT,
            label,
            type: "i2c_data",
          });
        }

        // STOP condition: SDA goes high while SCL is high
        transitions.I2C_SDA.push({ t: currentT, v: 0 });
        currentT += bitDuration;
        transitions.I2C_SCL.push({ t: currentT, v: 1 });
        currentT += bitDuration;
        transitions.I2C_SDA.push({ t: currentT, v: 1 });

        decodedPeriods.I2C_SDA.push({
          startTime_ns: currentT - bitDuration * 2,
          endTime_ns: currentT,
          label: "P",
          type: "i2c_stop",
        });
      }
    }

    // Sort and clean up all transitions
    for (const channel of Object.keys(transitions)) {
      transitions[channel].sort((a, b) => a.t - b.t);
      const unique: Transition[] = [];
      let prevValue: number | null = null;
      for (const t of transitions[channel]) {
        if (t.v !== prevValue) {
          unique.push(t);
          prevValue = t.v;
        }
      }
      transitions[channel] = unique;
    }

    return { transitions, decodedPeriods };
  }
}
