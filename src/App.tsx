import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useVirtualizer } from "@tanstack/react-virtual";
import { 
  Play, 
  Square, 
  RefreshCw, 
  Cpu, 
  History, 
  Database, 
  Settings, 
  FileCode, 
  ListFilter,
  ArrowDown,
  AlertTriangle,
  Bell,
  Trash2,
  Sliders,
  CheckCircle,
  XCircle,
  Filter,
  Eye,
  Activity
} from "lucide-react";
import "./App.css";
import { WORLD_MAP_PATHS } from "./assets/worldMap";
import { WaveformCanvas } from "./timing/WaveformCanvas";
import { AlertEngine, AlertRule, FiredAlert, BUILT_IN_RULES } from "./alerts/AlertEngine";

interface Packet {
  id: number;
  timestamp_ns: number;
  protocol: string;
  raw_bytes: number[];
  direction: string;
  decoded_json?: string | null;
}

interface SerialPortInfo {
  name: string;
  manufacturer: string | null;
  vid: number | null;
  pid: number | null;
}

interface Capture {
  id: number;
  name: string;
  protocol: string;
  started_at: string;
  ended_at: string | null;
  packet_count: number;
}

// Rust types
interface RustNmeaFrame {
  sentence_type: string;
  fields: Record<string, string>;
  valid_checksum: boolean;
  raw: string;
}

interface RustModbusFrame {
  device_addr: number;
  function_code: number;
  function_name: string;
  registers: number[];
  valid_crc: boolean;
  is_error: boolean;
  error_code?: number | null;
}

interface RustAtCommandFrame {
  is_command: boolean;
  command_name: string;
  command_type: string;
  description: string;
  parameters: string[];
  expected_response: string;
  is_response: boolean;
  response_status: string;
  raw: string;
}

type DecodedPayload = 
  | { Nmea: RustNmeaFrame }
  | { Modbus: RustModbusFrame }
  | { At: RustAtCommandFrame }
  | { Raw: string };

const BAUD_RATES = [300, 1200, 9600, 19200, 57600, 115200, 230400, 460800];
const DATA_BITS = [5, 6, 7, 8];
const PARITIES = ["None", "Odd", "Even"];
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7];
const SPI_MODES = [0, 1, 2, 3];
const BIT_ORDERS = ["MSB", "LSB"];

interface Anomaly {
  anomaly_type: string; // "Timing", "Length", "I2C NACK", "CRC failure", "Duplicate", "Garbled data"
  severity: string;     // "info", "warning", "error"
  timestamp: number;
  packet_id: number;
  description: string;
  suggested_fix: string;
}

function App() {
  // Protocol Tab State
  const [activeTab, setActiveTab] = useState<"UART" | "SPI" | "I2C" | "USB">("UART");

  // Capture connection configuration
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>("");
  
  // UART Configuration
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [dataBits, setDataBits] = useState<number>(8);
  const [parity, setParity] = useState<string>("None");
  const [stopBits] = useState<number>(1);

  // SPI Configuration
  const [spiMosi, setSpiMosi] = useState<number>(0);
  const [spiMiso, setSpiMiso] = useState<number>(1);
  const [spiClk, setSpiClk] = useState<number>(2);
  const [spiCs, setSpiCs] = useState<number>(3);
  const [spiMode, setSpiMode] = useState<number>(0);
  const [spiBitOrder, setSpiBitOrder] = useState<string>("MSB");

  // I2C Configuration
  const [i2cSda, setI2cSda] = useState<number>(4);
  const [i2cScl, setI2cScl] = useState<number>(5);

  // Filters
  const [directionFilter, setDirectionFilter] = useState<"All" | "TX" | "RX">("All");
  const [anomaliesOnlyFilter, setAnomaliesOnlyFilter] = useState<boolean>(false);

  // Auto-detect States
  const [detectedProtocol, setDetectedProtocol] = useState<{ protocol: string; confidence: number } | null>(null);
  const [detectedBannerDismissed, setDetectedBannerDismissed] = useState<boolean>(false);
  const [appliedDecoder, setAppliedDecoder] = useState<string | null>("None");

  // Capture session states
  const [capturing, setCapturing] = useState<boolean>(false);
  const [activeCaptureId, setActiveCaptureId] = useState<number | null>(null);
  const [pastCaptures, setPastCaptures] = useState<Capture[]>([]);
  const [selectedCapture, setSelectedCapture] = useState<Capture | null>(null);

  // Live and loaded packets
  const [packets, setPackets] = useState<Packet[]>([]);
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [centerView, setCenterView] = useState<"packets" | "waveform">("packets");
  const [jumpTimestamp, setJumpTimestamp] = useState<number | null>(null);

  // Anomaly and Alert Panel State
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [firedAlerts, setFiredAlerts] = useState<FiredAlert[]>([]);
  const [alertsPanelOpen, setAlertsPanelOpen] = useState<boolean>(false);
  const [rulesEditorOpen, setRulesEditorOpen] = useState<boolean>(false);

  // Alerts configuration
  const [rules, setRules] = useState<AlertRule[]>(() => {
    const saved = localStorage.getItem("probetrace_alert_rules");
    return saved ? JSON.parse(saved) : BUILT_IN_RULES;
  });

  // Save rules to local storage when modified
  useEffect(() => {
    localStorage.setItem("probetrace_alert_rules", JSON.stringify(rules));
    if (alertEngineRef.current) {
      alertEngineRef.current.updateRules(rules);
    }
  }, [rules]);

  // Form states for adding/editing rules
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState<Partial<AlertRule>>({
    name: "",
    enabled: true,
    ruleType: "pattern",
    pattern: "",
    patternFormat: "ascii",
    lengthValue: 8,
    byteOffset: 0,
    byteValue: 0,
    delayMs: 1000,
    errorRatePercentage: 10,
    actionHighlight: true,
    actionBeep: false,
    actionNotification: false,
    actionPanel: true,
  });

  // Alert engine reference
  const alertEngineRef = useRef<AlertEngine | null>(null);

  // Initialize Alert Engine on mount
  useEffect(() => {
    alertEngineRef.current = new AlertEngine(rules, (alert) => {
      setFiredAlerts((prev) => [alert, ...prev]);
    });
  }, []);

  // Live decoding states for visual panels
  const [gpsRoute, setGpsRoute] = useState<{ lat: number; lon: number }[]>([]);
  const [modbusRegisters, setModbusRegisters] = useState<Record<number, number>>({});

  // Console / Decoder outputs
  const [decoderLogs, setDecoderLogs] = useState<string[]>(["UART protocol decoder initialized. Waiting for packets..."]);

  const parentRef = useRef<HTMLDivElement>(null);
  const uartBufferRef = useRef<string>("");

  // Load serial ports and history on mount
  useEffect(() => {
    refreshPorts();
    loadPastCaptures();
  }, []);

  // Set default port when active tab changes
  useEffect(() => {
    if (activeTab === "UART" && !selectedPort.startsWith("Mock UART")) {
      setSelectedPort("Mock UART Port");
    } else if (activeTab === "SPI" && !selectedPort.startsWith("Mock SPI")) {
      setSelectedPort("Mock SPI Analyzer");
    } else if (activeTab === "I2C" && !selectedPort.startsWith("Mock I2C")) {
      setSelectedPort("Mock I2C Analyzer");
    }
  }, [activeTab]);

  // Decode selected packet dynamically
  const [packetDecodedResult, setPacketDecodedResult] = useState<DecodedPayload | null>(null);
  useEffect(() => {
    if (!selectedPacket) {
      setPacketDecodedResult(null);
      return;
    }
    
    // If not "None", run the Tauri command to decode
    if (appliedDecoder && appliedDecoder !== "None") {
      invoke<DecodedPayload>("decode_packet", {
        bytes: selectedPacket.raw_bytes,
        decoder: appliedDecoder
      }).then((res) => {
        setPacketDecodedResult(res);
      }).catch((e) => {
        console.error("Failed to decode packet:", e);
        setPacketDecodedResult(null);
      });
    } else {
      setPacketDecodedResult(null);
    }
  }, [selectedPacket, appliedDecoder]);

  // Listen to live capture packets and auto-update live decoders state (map coordinates, registers etc)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenAnomaly: (() => void) | null = null;
    
    const setupListener = async () => {
      unlisten = await listen<Packet>("packet-received", (event) => {
        const newPacket = event.payload;
        
        // Feed packet to local AlertEngine
        if (alertEngineRef.current) {
          alertEngineRef.current.processPacket(newPacket);
        }

        setPackets((prev) => {
          const updated = [...prev, newPacket];
          
          // Decode live if UART stream matching active decoder
          if (newPacket.raw_bytes && newPacket.raw_bytes.length > 0) {
            if (newPacket.protocol === "UART") {
              const char = String.fromCharCode(newPacket.raw_bytes[0]);
              uartBufferRef.current += char;
              
              if (uartBufferRef.current.includes("\n") || uartBufferRef.current.length > 80) {
                const lines = uartBufferRef.current.split("\n");
                uartBufferRef.current = lines.pop() || "";
                
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  
                  // Run decoder logic on line if requested
                  if (appliedDecoder === "NMEA") {
                    invoke<DecodedPayload>("decode_packet", {
                      bytes: Array.from(new TextEncoder().encode(trimmed)),
                      decoder: "NMEA"
                    }).then((framePayload) => {
                      if ("Nmea" in framePayload) {
                        const frame = framePayload.Nmea;
                        let detail = `[NMEA] ${frame.sentence_type}: `;
                        if (frame.sentence_type === "GPRMC") {
                          const latDec = parseFloat(frame.fields["latitude_dec"]);
                          const lonDec = parseFloat(frame.fields["longitude_dec"]);
                          if (!isNaN(latDec) && !isNaN(lonDec)) {
                            setGpsRoute((prevRoute) => [...prevRoute, { lat: latDec, lon: lonDec }]);
                          }
                          detail += `Speed: ${frame.fields["speed_knots"]} knots, Course: ${frame.fields["course"]}`;
                        } else if (frame.sentence_type === "GPGGA") {
                          detail += `Fix Quality: ${frame.fields["fix_quality"]}, Satellites: ${frame.fields["satellites"]}, Alt: ${frame.fields["altitude"]}`;
                        } else if (frame.sentence_type === "GPGSV") {
                          detail += `In View: ${frame.fields["satellites_in_view"]}`;
                        } else if (frame.sentence_type === "GPVTG") {
                          detail += `Speed: ${frame.fields["speed_kmh"]} km/h`;
                        } else {
                          detail += `${trimmed}`;
                        }
                        setDecoderLogs((logs) => [...logs, detail]);
                      }
                    }).catch(() => {});
                  } else if (appliedDecoder === "AT Commands") {
                    invoke<DecodedPayload>("decode_packet", {
                      bytes: Array.from(new TextEncoder().encode(trimmed)),
                      decoder: "AT Commands"
                    }).then((framePayload) => {
                      if ("At" in framePayload) {
                        const frame = framePayload.At;
                        if (frame.is_command) {
                          setDecoderLogs((logs) => [...logs, `[AT CMD] ${frame.command_name} (${frame.command_type}) - ${frame.description}`]);
                        } else if (frame.is_response) {
                          setDecoderLogs((logs) => [...logs, `[AT RESP] Status: ${frame.response_status} [${frame.parameters.join(", ")}]`]);
                        }
                      }
                    }).catch(() => {});
                  } else if (appliedDecoder === "Modbus RTU") {
                    // Try to decode packet from UART stream
                  } else {
                    setDecoderLogs((logs) => [...logs, `[UART]: ${trimmed}`]);
                  }
                }
              }
            } else if (newPacket.protocol === "SPI" && newPacket.decoded_json) {
              try {
                const decoded = JSON.parse(newPacket.decoded_json);
                const mosiAsc = decoded.mosi_bytes.map((b: number) => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join("");
                const misoAsc = decoded.miso_bytes.map((b: number) => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join("");
                setDecoderLogs((logs) => [
                  ...logs,
                  `[SPI Frame] MOSI: "${mosiAsc}" | MISO: "${misoAsc}"`,
                ]);
              } catch {}
            } else if (newPacket.protocol === "I2C" && newPacket.decoded_json) {
              try {
                const decoded = JSON.parse(newPacket.decoded_json);
                const dataHex = decoded.data_bytes.map((b: number) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
                const errorStr = decoded.error ? ` | Error: ${decoded.error}` : "";
                setDecoderLogs((logs) => [
                  ...logs,
                  `[I2C] Addr 0x${decoded.address.toString(16).toUpperCase()} ${decoded.direction} | Data: [${dataHex}]${errorStr}`,
                ]);
              } catch {}
            }
            
            // If Modbus RTU decoder is active, process all incoming packets as Modbus
            if (appliedDecoder === "Modbus RTU") {
              invoke<DecodedPayload>("decode_packet", {
                bytes: newPacket.raw_bytes,
                decoder: "Modbus RTU"
              }).then((framePayload) => {
                if ("Modbus" in framePayload) {
                  const frame = framePayload.Modbus;
                  let info = `[Modbus] Address: ${frame.device_addr} | Function: ${frame.function_name}`;
                  if (frame.valid_crc) {
                    if (!frame.is_error && frame.registers.length > 0) {
                      const baseAddr = 40001;
                      const updatedRegs = { ...modbusRegisters };
                      frame.registers.forEach((val, idx) => {
                        updatedRegs[baseAddr + idx] = val;
                      });
                      setModbusRegisters(updatedRegs);
                    }
                    info += ` | Registers: ${JSON.stringify(frame.registers)}`;
                  } else {
                    info += ` | Invalid CRC`;
                  }
                  setDecoderLogs((logs) => [...logs, info]);
                }
              }).catch(() => {});
            }
          }
          return updated;
        });
      });

      unlistenAnomaly = await listen<Anomaly>("anomaly-detected", (event) => {
        setAnomalies((prev) => {
          // Prevent duplicates by checking packet_id and description
          const item = event.payload;
          if (prev.some(a => a.packet_id === item.packet_id && a.description === item.description)) {
            return prev;
          }
          return [item, ...prev];
        });
      });
    };

    if (capturing) {
      setupListener();
    }

    return () => {
      if (unlisten) unlisten();
      if (unlistenAnomaly) unlistenAnomaly();
    };
  }, [capturing, appliedDecoder, modbusRegisters]);

  // Trigger auto-detect when we have enough packets in UART
  useEffect(() => {
    if (activeTab === "UART" && capturing && packets.length >= 15 && activeCaptureId !== null && !detectedProtocol && !detectedBannerDismissed) {
      const runDetect = async () => {
        try {
          const results = await invoke<{ protocol: string; confidence: number }[]>("detect_uart_protocol", {
            captureId: activeCaptureId,
          });
          if (results && results.length > 0) {
            const top = results[0];
            if (top.confidence >= 50 && top.protocol !== "Raw binary") {
              let cleanProto = top.protocol;
              if (top.protocol === "NMEA GPS") {
                cleanProto = "NMEA";
              }
              setDetectedProtocol({ protocol: cleanProto, confidence: top.confidence });
            }
          }
        } catch (err) {
          console.error("Auto-detect failed:", err);
        }
      };
      runDetect();
    }
  }, [packets.length, capturing, activeCaptureId, activeTab, detectedProtocol, detectedBannerDismissed]);

  // Handle auto-scroll
  useEffect(() => {
    if (autoScroll && packets.length > 0 && parentRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
  }, [packets.length, autoScroll]);

  // Fetch serial ports
  const refreshPorts = async () => {
    try {
      const availablePorts = await invoke<SerialPortInfo[]>("list_ports");
      setPorts(availablePorts);
      if (availablePorts.length > 0 && !selectedPort) {
        setSelectedPort("Mock UART Port");
      }
    } catch (err) {
      console.error("Failed to list ports:", err);
    }
  };

  // Fetch captures database
  const loadPastCaptures = async () => {
    try {
      const history = await invoke<Capture[]>("get_captures");
      setPastCaptures(history);
    } catch (err) {
      console.error("Failed to load captures:", err);
    }
  };

  // Start Captures
  const handleStartCapture = async () => {
    if (!selectedPort) {
      alert("Please select a port");
      return;
    }
    try {
      setPackets([]);
      setAnomalies([]);
      setFiredAlerts([]);
      if (alertEngineRef.current) {
        alertEngineRef.current.resetStats();
      }
      setDecoderLogs(["UART capture started.", `Config: ${selectedPort} @ ${baudRate} bps (${dataBits}N${stopBits})`]);
      setSelectedPacket(null);
      setSelectedCapture(null);
      setDetectedProtocol(null);
      setDetectedBannerDismissed(false);
      setGpsRoute([]);
      setModbusRegisters({});
      uartBufferRef.current = "";

      const captureId = await invoke<number>("start_capture", {
        port: selectedPort,
        baud: baudRate,
        dataBits,
        parity,
        stopBits,
      });

      setActiveCaptureId(captureId);
      setCapturing(true);
      loadPastCaptures();
    } catch (err) {
      alert(`Capture Error: ${err}`);
    }
  };

  const handleStartSpiCapture = async () => {
    if (!selectedPort) {
      alert("Please select a port");
      return;
    }
    try {
      setPackets([]);
      setAnomalies([]);
      setFiredAlerts([]);
      if (alertEngineRef.current) {
        alertEngineRef.current.resetStats();
      }
      setDecoderLogs(["SPI capture started.", `Config: ${selectedPort} | MOSI: CH${spiMosi}, MISO: CH${spiMiso}, CLK: CH${spiClk}, CS: CH${spiCs} (Mode ${spiMode})`]);
      setSelectedPacket(null);
      setSelectedCapture(null);
      setDetectedProtocol(null);
      setDetectedBannerDismissed(false);

      const captureId = await invoke<number>("start_spi_capture", {
        port: selectedPort,
        mosiChannel: spiMosi,
        misoChannel: spiMiso,
        clkChannel: spiClk,
        csChannel: spiCs,
        mode: spiMode,
        bitOrder: spiBitOrder,
      });

      setActiveCaptureId(captureId);
      setCapturing(true);
      loadPastCaptures();
    } catch (err) {
      alert(`Capture Error: ${err}`);
    }
  };

  const handleStartI2cCapture = async () => {
    if (!selectedPort) {
      alert("Please select a port");
      return;
    }
    try {
      setPackets([]);
      setAnomalies([]);
      setFiredAlerts([]);
      if (alertEngineRef.current) {
        alertEngineRef.current.resetStats();
      }
      setDecoderLogs(["I2C capture started.", `Config: ${selectedPort} | SDA: CH${i2cSda}, SCL: CH${i2cScl}`]);
      setSelectedPacket(null);
      setSelectedCapture(null);
      setDetectedProtocol(null);
      setDetectedBannerDismissed(false);

      const captureId = await invoke<number>("start_i2c_capture", {
        port: selectedPort,
        sdaChannel: i2cSda,
        sclChannel: i2cScl,
      });

      setActiveCaptureId(captureId);
      setCapturing(true);
      loadPastCaptures();
    } catch (err) {
      alert(`Capture Error: ${err}`);
    }
  };

  const handleStartCaptureClick = () => {
    if (activeTab === "UART") handleStartCapture();
    else if (activeTab === "SPI") handleStartSpiCapture();
    else if (activeTab === "I2C") handleStartI2cCapture();
  };

  // Stop Capture
  const handleStopCapture = async () => {
    try {
      await invoke("stop_capture");
      setCapturing(false);
      setActiveCaptureId(null);
      setDecoderLogs((prev) => [...prev, "Capture stopped."]);
      loadPastCaptures();
    } catch (err) {
      console.error("Stop Error:", err);
    }
  };

  // Select a past capture session
  const handleSelectCapture = async (cap: Capture) => {
    if (capturing) {
      alert("Please stop the active capture first.");
      return;
    }
    setSelectedCapture(cap);
    try {
      const capPackets = await invoke<Packet[]>("get_captured_packets", {
        captureId: cap.id,
        offset: 0,
        limit: 10000,
      });
      setPackets(capPackets);
      setSelectedPacket(capPackets[0] || null);

      // Extract anomalies embedded in packets
      const extAnomalies: Anomaly[] = [];
      capPackets.forEach((pkt) => {
        if (pkt.decoded_json) {
          try {
            const parsed = JSON.parse(pkt.decoded_json);
            if (parsed.anomalies) {
              extAnomalies.push(...parsed.anomalies);
            }
          } catch {}
        }
      });
      setAnomalies(extAnomalies);
      setFiredAlerts([]);

      setDecoderLogs([
        `Loaded Capture: ${cap.name}`,
        `Protocol: ${cap.protocol}`,
        `Started at: ${new Date(cap.started_at).toLocaleString()}`,
        `Packet count: ${cap.packet_count}`,
      ]);
      setDetectedProtocol(null);
      setDetectedBannerDismissed(true);
      setGpsRoute([]);
      setModbusRegisters({});
      
      if (cap.protocol.includes("NMEA")) {
        setAppliedDecoder("NMEA");
      } else if (cap.protocol.includes("Modbus")) {
        setAppliedDecoder("Modbus RTU");
      } else if (cap.protocol.includes("AT")) {
        setAppliedDecoder("AT Commands");
      }
    } catch (err) {
      alert(`Failed to load capture packets: ${err}`);
    }
  };

  // Filter packets
  const filteredPackets = useMemo(() => {
    return packets.filter((packet) => {
      // 1. Direction Filter
      let pass = true;
      if (directionFilter === "TX") {
        pass = ["TX", "MOSI", "Write"].includes(packet.direction);
      } else if (directionFilter === "RX") {
        pass = ["RX", "MISO", "Read"].includes(packet.direction);
      }

      // 2. Anomalies Only Filter
      if (anomaliesOnlyFilter) {
        const hasAnomaly = anomalies.some(a => a.packet_id === packet.id) || packet.decoded_json?.includes("anomalies") || packet.decoded_json?.includes("error");
        pass = pass && !!hasAnomaly;
      }
      return pass;
    });
  }, [packets, directionFilter, anomaliesOnlyFilter, anomalies]);

  // Format nano timestamp to a readable clock format
  const formatTimestamp = (ns: number) => {
    if (!ns) return "00:00:00.000000";
    const ms = Math.floor(ns / 1_000_000);
    const date = new Date(ms);
    const timeStr = date.toISOString().split("T")[1].replace("Z", "");
    const remainingNs = ns % 1_000_000;
    return `${timeStr}.${remainingNs.toString().padStart(6, "0")}`;
  };

  // Virtualizer for packets list
  const rowVirtualizer = useVirtualizer({
    count: filteredPackets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  // Check if packet has alert matches to highlight red
  const packetHasRedHighlightAlert = (packetId: number) => {
    return firedAlerts.some((a) => a.packetId === packetId && rules.find(r => r.id === a.ruleId)?.actionHighlight);
  };

  // Get color-coded classes for rows
  const getRowClass = (packet: Packet, isSelected: boolean) => {
    if (isSelected) {
      return "bg-indigo-600/35 text-indigo-200 border-l-2 border-l-indigo-500 font-semibold";
    }

    if (packetHasRedHighlightAlert(packet.id)) {
      return "bg-rose-950/40 text-rose-300 hover:bg-rose-950/50 border-l-2 border-l-rose-500";
    }
    
    // Check if contains backend error severity
    if (anomalies.some(a => a.packet_id === packet.id && a.severity === "error")) {
      return "bg-rose-950/20 text-rose-400 hover:bg-rose-950/30 border-l-2 border-l-rose-400/80";
    }

    if (packet.protocol === "UART") {
      return "bg-blue-950/10 text-blue-300 hover:bg-blue-950/20 border-l-2 border-l-blue-500/60";
    }
    if (packet.protocol === "SPI") {
      if (packet.direction === "MOSI") {
        return "bg-emerald-950/15 text-emerald-300 hover:bg-emerald-950/25 border-l-2 border-l-emerald-500/60";
      } else {
        return "bg-teal-950/15 text-teal-300 hover:bg-teal-950/25 border-l-2 border-l-teal-500/60";
      }
    }
    if (packet.protocol === "I2C") {
      if (packet.direction === "Write") {
        return "bg-orange-950/15 text-orange-300 hover:bg-orange-950/25 border-l-2 border-l-orange-500/60";
      } else {
        return "bg-yellow-950/15 text-yellow-300 hover:bg-yellow-950/25 border-l-2 border-l-yellow-600/60";
      }
    }
    return "bg-[#0b0f19]/40 text-gray-300 hover:bg-gray-800/20";
  };

  // Hex editor representation
  const hexDumpRows = useMemo(() => {
    if (!selectedPacket || !selectedPacket.raw_bytes) return [];
    const bytes = selectedPacket.raw_bytes;
    const rows = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.slice(i, i + 16);
      const offset = i.toString(16).padStart(8, "0").toUpperCase();
      
      const hexParts = [];
      for (let j = 0; j < 16; j++) {
        if (j < chunk.length) {
          hexParts.push(chunk[j].toString(16).padStart(2, "0").toUpperCase());
        } else {
          hexParts.push("  ");
        }
      }
      const hexStr = hexParts.slice(0, 8).join(" ") + "  " + hexParts.slice(8).join(" ");
      const asciiStr = chunk.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : ".")).join("");
      
      rows.push({ offset, hexStr, asciiStr });
    }
    return rows;
  }, [selectedPacket]);

  // Decode JSON payload from DB
  const decodedDetails = useMemo(() => {
    if (!selectedPacket || !selectedPacket.decoded_json) return null;
    try {
      return JSON.parse(selectedPacket.decoded_json);
    } catch {
      return null;
    }
  }, [selectedPacket]);

  // SVG coordinate projection for live map (-180..180 x -90..90 -> 0..300 x 0..150)
  const projectCoordinates = (lat: number, lon: number) => {
    const x = ((lon + 180) / 360) * 280;
    const y = ((90 - lat) / 180) * 140;
    return { x, y };
  };

  // Anomaly stats
  const anomalyStats = useMemo(() => {
    const counts: Record<string, number> = {
      "Timing": 0,
      "Length": 0,
      "I2C NACK": 0,
      "CRC failure": 0,
      "Duplicate": 0,
      "Garbled data": 0,
    };
    anomalies.forEach((a) => {
      if (counts[a.anomaly_type] !== undefined) {
        counts[a.anomaly_type]++;
      }
    });
    // Highlight the most frequent non-zero anomaly
    let mostFrequent = "";
    let maxVal = 0;
    Object.entries(counts).forEach(([k, v]) => {
      if (v > maxVal) {
        maxVal = v;
        mostFrequent = k;
      }
    });
    return { counts, mostFrequent };
  }, [anomalies]);

  // Alerts functions
  const handleDeleteRule = (id: string) => {
    setRules(rules.filter((r) => r.id !== id));
  };

  const handleToggleRule = (id: string) => {
    setRules(
      rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const handleEditRule = (rule: AlertRule) => {
    setEditingRuleId(rule.id);
    setRuleForm(rule);
    setRulesEditorOpen(true);
  };

  const handleSaveRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingRuleId) {
      setRules(
        rules.map((r) =>
          r.id === editingRuleId ? { ...(ruleForm as AlertRule), id: editingRuleId } : r
        )
      );
    } else {
      const newRule: AlertRule = {
        ...(ruleForm as AlertRule),
        id: `rule-${Date.now()}`,
      };
      setRules([...rules, newRule]);
    }
    setEditingRuleId(null);
    setRulesEditorOpen(false);
  };

  return (
    <div className="grid grid-rows-[auto_1fr_220px] grid-cols-[280px_1fr_320px] h-screen w-screen bg-[#0b0f19] text-[#e2e8f0] overflow-hidden select-none font-sans">
      
      {/* TOP BAR - Connection Controls */}
      <header className="col-span-3 border-b border-gray-800 bg-[#0f172a]/90 backdrop-blur px-4 py-2 flex flex-col md:flex-row items-center justify-between z-10 gap-3">
        {/* Logo and tabs */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-indigo-500 animate-pulse" />
            <span className="font-bold text-lg tracking-wider bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              ProbeTrace
            </span>
          </div>

          <div className="flex items-center bg-gray-900 rounded p-0.5 border border-gray-800">
            {(["UART", "SPI", "I2C", "USB"] as const).map((tab) => (
              <button
                key={tab}
                disabled={capturing}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 rounded text-xs font-semibold tracking-wider transition-all ${
                  activeTab === tab
                    ? "bg-indigo-600 text-white shadow"
                    : "text-gray-400 hover:text-gray-200 disabled:opacity-40"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Dynamic Controls based on Tab */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          
          {/* UART Configs */}
          {activeTab === "UART" && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Port:</span>
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  className="bg-transparent text-gray-200 outline-none cursor-pointer"
                  disabled={capturing}
                >
                  {ports.map((p) => (
                    <option key={p.name} value={p.name} className="bg-gray-900">{p.name}</option>
                  ))}
                </select>
                <button onClick={refreshPorts} disabled={capturing} className="hover:text-indigo-400 disabled:opacity-30 p-0.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Baud:</span>
                <select
                  value={baudRate}
                  onChange={(e) => setBaudRate(Number(e.target.value))}
                  className="bg-transparent text-gray-200 outline-none cursor-pointer"
                  disabled={capturing}
                >
                  {BAUD_RATES.map((rate) => (
                    <option key={rate} value={rate} className="bg-gray-900">{rate}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Data:</span>
                <select
                  value={dataBits}
                  onChange={(e) => setDataBits(Number(e.target.value))}
                  className="bg-transparent text-gray-200 outline-none cursor-pointer"
                  disabled={capturing}
                >
                  {DATA_BITS.map((db) => (
                    <option key={db} value={db} className="bg-gray-900">{db}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Parity:</span>
                <select
                  value={parity}
                  onChange={(e) => setParity(e.target.value)}
                  className="bg-transparent text-gray-200 outline-none cursor-pointer"
                  disabled={capturing}
                >
                  {PARITIES.map((p) => (
                    <option key={p} value={p} className="bg-gray-900">{p}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* SPI Configs */}
          {activeTab === "SPI" && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Analyzer Port:</span>
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  className="bg-transparent text-gray-200 outline-none cursor-pointer"
                  disabled={capturing}
                >
                  {ports.map((p) => (
                    <option key={p.name} value={p.name} className="bg-gray-900">{p.name}</option>
                  ))}
                </select>
                <button onClick={refreshPorts} disabled={capturing} className="hover:text-indigo-400 disabled:opacity-30 p-0.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">MOSI:</span>
                <select value={spiMosi} onChange={(e) => setSpiMosi(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {CHANNELS.map(ch => <option key={ch} value={ch} className="bg-gray-900">CH{ch}</option>)}
                </select>
                <span className="text-gray-400 font-medium ml-1">MISO:</span>
                <select value={spiMiso} onChange={(e) => setSpiMiso(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {CHANNELS.map(ch => <option key={ch} value={ch} className="bg-gray-900">CH{ch}</option>)}
                </select>
                <span className="text-gray-400 font-medium ml-1">CLK:</span>
                <select value={spiClk} onChange={(e) => setSpiClk(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {CHANNELS.map(ch => <option key={ch} value={ch} className="bg-gray-900">CH{ch}</option>)}
                </select>
                <span className="text-gray-400 font-medium ml-1">CS:</span>
                <select value={spiCs} onChange={(e) => setSpiCs(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {CHANNELS.map(ch => <option key={ch} value={ch} className="bg-gray-900">CH{ch}</option>)}
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Mode:</span>
                <select value={spiMode} onChange={(e) => setSpiMode(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {SPI_MODES.map(m => <option key={m} value={m} className="bg-gray-900">Mode {m}</option>)}
                </select>
                <span className="text-gray-400 font-medium ml-1">Order:</span>
                <select value={spiBitOrder} onChange={(e) => setSpiBitOrder(e.target.value)} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {BIT_ORDERS.map(o => <option key={o} value={o} className="bg-gray-900">{o}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* I2C Configs */}
          {activeTab === "I2C" && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">Analyzer Port:</span>
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  className="bg-transparent text-gray-200 outline-none cursor-pointer"
                  disabled={capturing}
                >
                  {ports.map((p) => (
                    <option key={p.name} value={p.name} className="bg-gray-900">{p.name}</option>
                  ))}
                </select>
                <button onClick={refreshPorts} disabled={capturing} className="hover:text-indigo-400 disabled:opacity-30 p-0.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-1.5 bg-gray-900/80 px-2 py-1.5 rounded border border-gray-800">
                <span className="text-gray-400 font-medium">SDA:</span>
                <select value={i2cSda} onChange={(e) => setI2cSda(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {CHANNELS.map(ch => <option key={ch} value={ch} className="bg-gray-900">CH{ch}</option>)}
                </select>
                <span className="text-gray-400 font-medium ml-2">SCL:</span>
                <select value={i2cScl} onChange={(e) => setI2cScl(Number(e.target.value))} className="bg-transparent text-gray-200 outline-none cursor-pointer" disabled={capturing}>
                  {CHANNELS.map(ch => <option key={ch} value={ch} className="bg-gray-900">CH{ch}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* USB Configs (Future Expansion) */}
          {activeTab === "USB" && (
            <div className="text-indigo-400 font-medium bg-indigo-950/40 px-3 py-1.5 rounded border border-indigo-900">
              USB Packet Analyzer Mode active
            </div>
          )}

        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Alerts panel toggle */}
          <button
            onClick={() => setAlertsPanelOpen(!alertsPanelOpen)}
            className={`relative p-1.5 rounded border text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              alertsPanelOpen 
                ? "bg-indigo-950 border-indigo-500 text-indigo-400" 
                : "bg-gray-900 border-gray-800 hover:border-gray-700 text-gray-400"
            }`}
            title="Toggle Alerts panel"
          >
            <Bell className="h-4 w-4" />
            Alerts
            {firedAlerts.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white font-bold text-[8px] h-4 w-4 flex items-center justify-center rounded-full animate-bounce">
                {firedAlerts.length}
              </span>
            )}
          </button>

          {/* Rules editor toggle */}
          <button
            onClick={() => setRulesEditorOpen(!rulesEditorOpen)}
            className={`p-1.5 rounded border text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              rulesEditorOpen 
                ? "bg-indigo-950 border-indigo-500 text-indigo-400" 
                : "bg-gray-900 border-gray-800 hover:border-gray-700 text-gray-400"
            }`}
            title="Configure Alert Rules"
          >
            <Sliders className="h-4 w-4" />
            Rules
          </button>

          {activeTab !== "USB" && (!capturing ? (
            <button
              onClick={handleStartCaptureClick}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 font-semibold text-xs text-white shadow-md shadow-emerald-950/20 active:scale-95 transition-all"
            >
              <Play className="h-3.5 w-3.5 fill-white" />
              Start Capture
            </button>
          ) : (
            <button
              onClick={handleStopCapture}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 font-semibold text-xs text-white shadow-md shadow-rose-950/20 active:scale-95 transition-all"
            >
              <Square className="h-3.5 w-3.5 fill-white" />
              Stop Capture
            </button>
          ))}
        </div>
      </header>

      {/* LEFT PANEL - Capture Sessions & Device Info */}
      <aside className="col-start-1 row-start-2 row-span-2 border-r border-gray-800 bg-[#0f172a] flex flex-col overflow-hidden">
        {/* Connection Status Banner */}
        <div className={`p-3 text-xs border-b border-gray-800 flex items-center justify-between ${capturing ? "bg-emerald-950/10 border-l-2 border-l-emerald-500" : "bg-gray-900/20 border-l-2 border-l-indigo-500"}`}>
          <div className="flex flex-col">
            <span className="font-semibold text-gray-300">Status</span>
            <span className="text-[10px] text-gray-400">
              {capturing ? `Capturing on ${selectedPort}` : "Ready to connect"}
            </span>
          </div>
          <span className={`w-2.5 h-2.5 rounded-full ${capturing ? "bg-emerald-500 animate-ping" : "bg-indigo-500"}`} />
        </div>

        {/* Anomaly Summary Sidebar */}
        <div className="p-3 border-b border-gray-800 bg-gray-900/30">
          <h3 className="text-xs uppercase font-bold tracking-wider text-gray-400 flex items-center gap-1.5 mb-2">
            <Activity className="h-3.5 w-3.5 text-indigo-400" /> Anomaly Summary
          </h3>
          <div className="space-y-1 text-[11px]">
            {Object.entries(anomalyStats.counts).map(([type, count]) => {
              const isMax = anomalyStats.mostFrequent === type && count > 0;
              return (
                <div 
                  key={type} 
                  className={`flex justify-between items-center px-2 py-1 rounded border transition-all ${
                    isMax 
                      ? "bg-rose-950/30 border-rose-800/60 text-rose-300 font-bold" 
                      : count > 0 
                        ? "bg-amber-950/15 border-amber-900/40 text-amber-400" 
                        : "bg-gray-900/20 border-gray-850 text-gray-500"
                  }`}
                >
                  <span>{type}</span>
                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${count > 0 ? (isMax ? "bg-rose-900 text-rose-200" : "bg-amber-900 text-amber-200") : "bg-gray-950 text-gray-600"}`}>
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Capture Sessions Section */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-gray-800 flex items-center justify-between">
            <h3 className="text-xs uppercase font-bold tracking-wider text-gray-400 flex items-center gap-1.5">
              <History className="h-3.5 w-3.5 text-indigo-400" /> Past Sessions
            </h3>
            <span className="text-[10px] font-bold text-gray-500 bg-gray-900 px-1.5 py-0.5 rounded border border-gray-800">
              {pastCaptures.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-800/40 font-mono text-[11px]">
            {pastCaptures.length === 0 ? (
              <div className="p-4 text-center text-gray-500 italic">
                No saved capture sessions
              </div>
            ) : (
              pastCaptures.map((cap) => {
                const isActive = activeCaptureId === cap.id;
                const isSelected = selectedCapture?.id === cap.id;
                return (
                  <div
                    key={cap.id}
                    onClick={() => handleSelectCapture(cap)}
                    className={`p-2.5 cursor-pointer transition-colors duration-150 relative ${
                      isActive 
                        ? "bg-emerald-950/20 hover:bg-emerald-950/30" 
                        : isSelected 
                          ? "bg-indigo-950/20 border-r-2 border-r-indigo-500" 
                          : "hover:bg-gray-800/30"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1 font-semibold text-gray-300">
                      <span className="truncate max-w-[150px]">{cap.name}</span>
                      <span className="text-[9px] text-gray-400 bg-gray-900 px-1 rounded">{cap.protocol}</span>
                    </div>
                    <div className="flex justify-between items-center text-[10px] text-gray-500">
                      <span>{new Date(cap.started_at).toLocaleTimeString()}</span>
                      <span className="flex items-center gap-1">
                        <Database className="h-2.5 w-2.5" />
                        {cap.packet_count} frames
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>

      {/* CENTER PANEL - Packet List */}
      <main className="col-start-2 row-start-2 border-b border-gray-800 bg-[#0b0f19] flex flex-col overflow-hidden relative">
        
        {/* Rules Editor Popup Overlay */}
        {rulesEditorOpen && (
          <div className="absolute inset-0 bg-[#070b14]/90 z-20 p-4 overflow-y-auto flex flex-col gap-4 border-b border-gray-800">
            <div className="flex items-center justify-between border-b border-gray-800 pb-2">
              <h3 className="font-bold text-indigo-400 flex items-center gap-1.5">
                <Sliders className="h-4 w-4" /> Alert Rules Configuration
              </h3>
              <button 
                onClick={() => { setRulesEditorOpen(false); setEditingRuleId(null); }}
                className="text-gray-400 hover:text-gray-200 text-xs font-bold"
              >
                ✕ Close
              </button>
            </div>

            {/* Rule form */}
            <form onSubmit={handleSaveRule} className="bg-[#0f172a] border border-gray-800 rounded p-3 text-xs space-y-3">
              <div className="font-semibold text-gray-300">{editingRuleId ? "Edit Rule" : "Create New Rule"}</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-gray-400 block font-medium">Rule Name</label>
                  <input
                    type="text"
                    required
                    value={ruleForm.name}
                    onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
                    className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500"
                    placeholder="e.g. Alert on byte error"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-gray-400 block font-medium">Trigger Type</label>
                  <select
                    value={ruleForm.ruleType}
                    onChange={(e) => setRuleForm({ ...ruleForm, ruleType: e.target.value as any })}
                    className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none cursor-pointer focus:border-indigo-500"
                  >
                    <option value="pattern">Packet matches pattern (regex)</option>
                    <option value="length_equals">Packet length equals value</option>
                    <option value="length_exceeds">Packet length exceeds value</option>
                    <option value="byte_offset">Specific byte value at offset</option>
                    <option value="delay_exceeds">Inter-packet delay exceeds (ms)</option>
                    <option value="error_rate">Error rate exceeds percentage</option>
                  </select>
                </div>
              </div>

              {/* Conditional Fields */}
              {ruleForm.ruleType === "pattern" && (
                <div className="grid grid-cols-2 gap-3 border-t border-gray-800/40 pt-2">
                  <div className="space-y-1">
                    <label className="text-gray-400 block font-medium">Regex Pattern</label>
                    <input
                      type="text"
                      required
                      value={ruleForm.pattern}
                      onChange={(e) => setRuleForm({ ...ruleForm, pattern: e.target.value })}
                      className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500 font-mono"
                      placeholder="e.g. NACK|Error"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-gray-400 block font-medium">Format to Match</label>
                    <select
                      value={ruleForm.patternFormat}
                      onChange={(e) => setRuleForm({ ...ruleForm, patternFormat: e.target.value as any })}
                      className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none cursor-pointer focus:border-indigo-500"
                    >
                      <option value="ascii">ASCII text string representation</option>
                      <option value="hex">Hexadecimal string representation</option>
                    </select>
                  </div>
                </div>
              )}

              {(ruleForm.ruleType === "length_equals" || ruleForm.ruleType === "length_exceeds") && (
                <div className="space-y-1 border-t border-gray-800/40 pt-2">
                  <label className="text-gray-400 block font-medium">Packet Length (bytes)</label>
                  <input
                    type="number"
                    required
                    value={ruleForm.lengthValue}
                    onChange={(e) => setRuleForm({ ...ruleForm, lengthValue: Number(e.target.value) })}
                    className="w-24 bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              {ruleForm.ruleType === "byte_offset" && (
                <div className="grid grid-cols-2 gap-3 border-t border-gray-800/40 pt-2">
                  <div className="space-y-1">
                    <label className="text-gray-400 block font-medium">Byte Offset (0-indexed)</label>
                    <input
                      type="number"
                      required
                      value={ruleForm.byteOffset}
                      onChange={(e) => setRuleForm({ ...ruleForm, byteOffset: Number(e.target.value) })}
                      className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-gray-400 block font-medium">Expected Byte Value (0-255 decimal)</label>
                    <input
                      type="number"
                      required
                      value={ruleForm.byteValue}
                      onChange={(e) => setRuleForm({ ...ruleForm, byteValue: Number(e.target.value) })}
                      className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              )}

              {ruleForm.ruleType === "delay_exceeds" && (
                <div className="space-y-1 border-t border-gray-800/40 pt-2">
                  <label className="text-gray-400 block font-medium">Inactivity Delay (milliseconds)</label>
                  <input
                    type="number"
                    required
                    value={ruleForm.delayMs}
                    onChange={(e) => setRuleForm({ ...ruleForm, delayMs: Number(e.target.value) })}
                    className="w-32 bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              {ruleForm.ruleType === "error_rate" && (
                <div className="space-y-1 border-t border-gray-800/40 pt-2">
                  <label className="text-gray-400 block font-medium">Error Rate Threshold (%)</label>
                  <input
                    type="number"
                    required
                    value={ruleForm.errorRatePercentage}
                    onChange={(e) => setRuleForm({ ...ruleForm, errorRatePercentage: Number(e.target.value) })}
                    className="w-32 bg-gray-900 border border-gray-800 rounded px-2.5 py-1 text-gray-200 outline-none focus:border-indigo-500"
                  />
                </div>
              )}

              {/* Action Checkboxes */}
              <div className="border-t border-gray-800/40 pt-2 space-y-1">
                <span className="text-gray-400 font-semibold block mb-1">Actions to Execute</span>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ruleForm.actionHighlight}
                      onChange={(e) => setRuleForm({ ...ruleForm, actionHighlight: e.target.checked })}
                    />
                    Highlight packet row (Red)
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ruleForm.actionBeep}
                      onChange={(e) => setRuleForm({ ...ruleForm, actionBeep: e.target.checked })}
                    />
                    Play warning beep sound
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ruleForm.actionNotification}
                      onChange={(e) => setRuleForm({ ...ruleForm, actionNotification: e.target.checked })}
                    />
                    Tauri desktop notification
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ruleForm.actionPanel}
                      onChange={(e) => setRuleForm({ ...ruleForm, actionPanel: e.target.checked })}
                    />
                    Log inside Alerts panel
                  </label>
                </div>
              </div>

              {/* Form buttons */}
              <div className="flex gap-2 justify-end border-t border-gray-800/40 pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingRuleId(null);
                    setRuleForm({
                      name: "",
                      enabled: true,
                      ruleType: "pattern",
                      pattern: "",
                      patternFormat: "ascii",
                      lengthValue: 8,
                      byteOffset: 0,
                      byteValue: 0,
                      delayMs: 1000,
                      errorRatePercentage: 10,
                      actionHighlight: true,
                      actionBeep: false,
                      actionNotification: false,
                      actionPanel: true,
                    });
                  }}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1 rounded transition-colors"
                >
                  Clear Form
                </button>
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-4 py-1 rounded transition-colors"
                >
                  {editingRuleId ? "Update Rule" : "Create Rule"}
                </button>
              </div>
            </form>

            {/* List of rules */}
            <div className="space-y-1.5">
              <div className="font-semibold text-gray-400">Current Active Rules ({rules.length})</div>
              <div className="grid grid-cols-1 gap-2 max-h-[220px] overflow-y-auto pr-1">
                {rules.map((rule) => (
                  <div key={rule.id} className="bg-gray-900 border border-gray-850 p-2 rounded flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => handleToggleRule(rule.id)}
                        className="cursor-pointer"
                      />
                      <div className="flex flex-col">
                        <span className={`font-semibold ${rule.enabled ? "text-gray-200" : "text-gray-500 line-through"}`}>{rule.name}</span>
                        <span className="text-[10px] text-gray-500 font-mono">Type: {rule.ruleType}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => handleEditRule(rule)} 
                        className="text-indigo-400 hover:text-indigo-300 font-bold"
                      >
                        Edit
                      </button>
                      <button 
                        onClick={() => handleDeleteRule(rule.id)} 
                        className="text-rose-500 hover:text-rose-400 font-bold"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Alerts panel Overlay */}
        {alertsPanelOpen && (
          <div className="absolute inset-x-0 bottom-0 top-10 bg-[#070b14]/95 z-20 flex flex-col border-t border-gray-800">
            <div className="bg-[#0f172a] px-4 py-2 border-b border-gray-800 flex items-center justify-between text-xs">
              <span className="font-bold text-rose-400 flex items-center gap-1.5">
                <Bell className="h-4 w-4" /> Chronological Fired Alerts Log ({firedAlerts.length})
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setFiredAlerts([])}
                  className="text-gray-400 hover:text-rose-400 font-semibold"
                >
                  Clear Log
                </button>
                <button 
                  onClick={() => setAlertsPanelOpen(false)}
                  className="text-gray-400 hover:text-gray-200 font-bold"
                >
                  ✕ Close
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-[11px]">
              {firedAlerts.length === 0 ? (
                <div className="text-center text-gray-500 italic p-6">No alerts have fired in this capture session.</div>
              ) : (
                firedAlerts.map((alert) => (
                  <div 
                    key={alert.id}
                    onClick={() => {
                      // Find packet
                      const p = packets.find((pkt) => pkt.id === alert.packetId);
                      if (p) {
                        setSelectedPacket(p);
                        setJumpTimestamp(p.timestamp_ns);
                        setAlertsPanelOpen(false);
                      }
                    }}
                    className="bg-rose-950/20 hover:bg-rose-950/30 border border-rose-900/40 p-2 rounded flex justify-between items-start cursor-pointer hover:border-rose-700 transition-colors"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-rose-400 font-bold bg-rose-950 px-1 rounded text-[9px] uppercase">Fired</span>
                        <span className="text-gray-200 font-semibold">{alert.ruleName}</span>
                      </div>
                      <p className="text-gray-400">{alert.packetDescription}</p>
                    </div>
                    <div className="text-right text-[10px] text-gray-500">
                      <div>Packet #{alert.packetId}</div>
                      <div>{new Date(alert.timestamp).toLocaleTimeString()}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        
        {/* Protocol Auto-detection Banner */}
        {detectedProtocol && !detectedBannerDismissed && (
          <div className="bg-indigo-950/90 border-b border-indigo-500/30 px-4 py-2.5 flex items-center justify-between text-xs text-indigo-200 z-10">
            <div className="flex items-center gap-2">
              <span className="font-semibold bg-indigo-900/60 border border-indigo-700/50 px-2 py-0.5 rounded text-[10px] uppercase text-indigo-300">
                Auto-detection
              </span>
              <span>
                Looks like <strong>{detectedProtocol.protocol}</strong> data ({Math.round(detectedProtocol.confidence)}% confidence) — Apply decoder?
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setAppliedDecoder(detectedProtocol.protocol);
                  setDecoderLogs((prev) => [
                    ...prev,
                    `[Auto-detect] Applied ${detectedProtocol.protocol} protocol decoder.`,
                  ]);
                  setDetectedBannerDismissed(true);
                }}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-2.5 py-1 rounded transition-colors text-[11px]"
              >
                Apply
              </button>
              <button
                onClick={() => setDetectedBannerDismissed(true)}
                className="hover:text-indigo-400 text-indigo-300 font-semibold px-2 py-1 rounded transition-colors text-[11px]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* View Switch Header Tabs */}
        <div className="bg-[#0f172a] border-b border-gray-800/80 px-4 py-2 flex items-center justify-between text-xs select-none">
          <div className="flex items-center gap-1.5 bg-gray-950/80 border border-gray-850 p-0.5 rounded">
            <button
              onClick={() => setCenterView("packets")}
              className={`px-3 py-1.5 rounded text-[11px] font-semibold transition-all ${
                centerView === "packets"
                  ? "bg-indigo-600 text-white shadow-sm font-bold"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Packet List
            </button>
            <button
              onClick={() => setCenterView("waveform")}
              className={`px-3 py-1.5 rounded text-[11px] font-semibold transition-all ${
                centerView === "waveform"
                  ? "bg-indigo-600 text-white shadow-sm font-bold"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Waveform Timeline
            </button>
          </div>
          
          <div className="flex items-center gap-1 bg-gray-950/80 border border-gray-850 p-0.5 rounded">
            <button
              onClick={() => setAnomaliesOnlyFilter(!anomaliesOnlyFilter)}
              className={`px-3 py-1 rounded text-[11px] font-semibold transition-all flex items-center gap-1 ${
                anomaliesOnlyFilter
                  ? "bg-rose-900 text-rose-100 shadow"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              Anomalies Only
            </button>
          </div>
        </div>

        {centerView === "packets" ? (
          <>
            {/* Table Header */}
            <div className="bg-gray-900/50 border-b border-gray-800 text-[11px] font-bold text-gray-400 grid grid-cols-[60px_130px_70px_70px_1fr_120px] divide-x divide-gray-800/60 uppercase tracking-wider py-2 select-none">
              <div className="px-3 text-center">#</div>
              <div className="px-3">Time</div>
              <div className="px-3 text-center">Dir</div>
              <div className="px-3 text-center">Len</div>
              <div className="px-3">Hex</div>
              <div className="px-3">ASCII</div>
            </div>

            {/* Packet Scroll View */}
            <div 
              ref={parentRef}
              className="flex-1 overflow-y-auto min-h-0 bg-[#070b14] scrollbar-thin scrollbar-track-transparent scrollbar-thumb-gray-800"
            >
              {filteredPackets.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-500 text-xs p-6 gap-2">
                  <ListFilter className="h-6 w-6 text-gray-600 animate-pulse" />
                  <span>No packets match the current filters.</span>
                </div>
              ) : (
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const packet = filteredPackets[virtualRow.index];
                    const isSelected = selectedPacket?.id === packet.id;
                    
                    const hexRep = packet.raw_bytes.map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
                    const asciiRep = packet.raw_bytes.map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join("");
                    
                    // Check if there are backend anomalies on this row
                    const rowAnomalies = anomalies.filter(a => a.packet_id === packet.id);
                    const isErr = rowAnomalies.some(a => a.severity === "error");

                    return (
                      <div
                        key={packet.id}
                        onClick={() => {
                          setSelectedPacket(packet);
                          setJumpTimestamp(packet.timestamp_ns);
                        }}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        className={`grid grid-cols-[60px_130px_70px_70px_1fr_120px] divide-x divide-gray-900/60 text-xs font-mono items-center cursor-pointer border-b border-gray-900/30 transition-colors ${getRowClass(packet, isSelected)}`}
                      >
                        <div className="px-3 text-center text-gray-500 flex items-center justify-center gap-1">
                          {rowAnomalies.length > 0 && (
                            <AlertTriangle className={`h-3.5 w-3.5 ${isErr ? "text-rose-500 animate-pulse" : "text-amber-500"}`} title={rowAnomalies.map(a => a.description).join('\n')} />
                          )}
                          {packet.id}
                        </div>
                        <div className="px-3 text-gray-400 truncate">{formatTimestamp(packet.timestamp_ns)}</div>
                        <div className="px-3 text-center">
                          <span className={`px-1 py-0.2 rounded text-[10px] font-bold ${
                            ["TX", "MOSI", "Write"].includes(packet.direction)
                              ? "bg-purple-950/50 text-purple-400 border border-purple-900/60"
                              : "bg-emerald-950/50 text-emerald-400 border border-emerald-900/60"
                          }`}>
                            {packet.direction}
                          </span>
                        </div>
                        <div className="px-3 text-center text-gray-400">{packet.raw_bytes.length}</div>
                        <div className="px-3 font-semibold truncate select-text">{hexRep}</div>
                        <div className="px-3 font-semibold truncate select-text">{asciiRep}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <WaveformCanvas
            packets={packets}
            selectedPacket={selectedPacket}
            onSelectPacket={(p) => {
              setSelectedPacket(p);
            }}
            jumpTimestamp={jumpTimestamp}
          />
        )}

        {/* Table Footer / Filters and Controls */}
        <div className="bg-[#0f172a] border-t border-gray-800/80 px-3 py-1.5 flex items-center justify-between text-xs text-gray-400 select-none">
          <div className="flex items-center gap-4">
            <span>Buffer Size: <strong className="text-gray-200">{filteredPackets.length} frames</strong></span>
            
            {/* Direction Filter buttons */}
            <div className="flex items-center bg-gray-900 border border-gray-800 rounded p-0.5 gap-0.5 ml-2">
              {(["All", "TX", "RX"] as const).map((dir) => (
                <button
                  key={dir}
                  onClick={() => setDirectionFilter(dir)}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-all ${
                    directionFilter === dir
                      ? "bg-indigo-600 text-white"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {dir}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] transition-colors ${
                autoScroll
                  ? "bg-indigo-950/60 border-indigo-700 text-indigo-400 font-semibold"
                  : "bg-gray-900 border-gray-800 hover:border-gray-700 text-gray-500"
              }`}
            >
              <ArrowDown className={`h-3 w-3 ${autoScroll ? "animate-bounce" : ""}`} />
              Auto Scroll
            </button>
          </div>
        </div>
      </main>

      {/* RIGHT PANEL - Protocol Decoder Output */}
      <aside className="col-start-3 row-start-2 row-span-2 border-l border-gray-800 bg-[#0f172a] flex flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between bg-[#111827]">
          <div className="flex items-center gap-2">
            <FileCode className="h-4 w-4 text-indigo-400" />
            <h3 className="text-xs uppercase font-bold tracking-wider text-gray-300">
              Protocol Decoder
            </h3>
          </div>
          
          <select 
            value={appliedDecoder || "None"}
            onChange={(e) => {
              setAppliedDecoder(e.target.value);
              setDecoderLogs((prev) => [...prev, `[Decoder] Switch to ${e.target.value}`]);
            }}
            className="bg-[#0b0f19] text-xs font-semibold text-gray-300 border border-gray-800 rounded px-2 py-1 outline-none cursor-pointer"
          >
            <option value="None">None</option>
            <option value="NMEA">NMEA</option>
            <option value="Modbus RTU">Modbus RTU</option>
            <option value="AT Commands">AT Commands</option>
            <option value="Raw Hex">Raw Hex</option>
          </select>
        </div>

        {/* Decoder visual panels */}
        {appliedDecoder === "NMEA" && (
          <div className="p-3 border-b border-gray-800 bg-[#0b0f19]/80 space-y-3 flex flex-col items-center">
            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 self-start">Live GPS Map Outline</span>
            <div className="relative w-[280px] h-[140px] bg-[#070b14] border border-gray-800 rounded overflow-hidden">
              <svg className="w-full h-full text-gray-800" viewBox="0 0 280 140">
                <g fill="currentColor" opacity="0.15">
                  {WORLD_MAP_PATHS.map((path, idx) => (
                    <path key={idx} d={path} transform="scale(0.77) translate(180, 90)" />
                  ))}
                </g>
                
                {/* Plot the track */}
                {gpsRoute.length > 1 && (
                  <polyline
                    fill="none"
                    stroke="#818cf8"
                    strokeWidth="1.5"
                    points={gpsRoute.map(p => {
                      const projected = projectCoordinates(p.lat, p.lon);
                      return `${projected.x},${projected.y}`;
                    }).join(" ")}
                  />
                )}
                
                {/* Current Dot */}
                {gpsRoute.length > 0 && (() => {
                  const curr = gpsRoute[gpsRoute.length - 1];
                  const projected = projectCoordinates(curr.lat, curr.lon);
                  return (
                    <circle
                      cx={projected.x}
                      cy={projected.y}
                      r="4"
                      fill="#ef4444"
                      className="animate-ping"
                    />
                  );
                })()}
                {gpsRoute.length > 0 && (() => {
                  const curr = gpsRoute[gpsRoute.length - 1];
                  const projected = projectCoordinates(curr.lat, curr.lon);
                  return (
                    <circle
                      cx={projected.x}
                      cy={projected.y}
                      r="2.5"
                      fill="#f87171"
                    />
                  );
                })()}
              </svg>
              {gpsRoute.length > 0 && (
                <div className="absolute bottom-1 right-1 bg-gray-900/90 border border-gray-800 rounded px-1.5 py-0.5 text-[9px] font-mono text-gray-300">
                  Lat: {gpsRoute[gpsRoute.length-1].lat.toFixed(4)}°, Lon: {gpsRoute[gpsRoute.length-1].lon.toFixed(4)}°
                </div>
              )}
            </div>
          </div>
        )}

        {appliedDecoder === "Modbus RTU" && (
          <div className="p-3 border-b border-gray-800 bg-[#0b0f19]/80 flex flex-col overflow-hidden max-h-[220px]">
            <span className="text-[10px] font-bold uppercase tracking-wider text-orange-400 mb-1">Live Register Table</span>
            <div className="flex-1 overflow-y-auto border border-gray-800 rounded bg-[#070b14] text-[9px] font-mono">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-900/60 text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800">
                    <th className="p-1 border-r border-gray-800">Address</th>
                    <th className="p-1">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/40 text-gray-300">
                  {Object.keys(modbusRegisters).length === 0 ? (
                    <tr>
                      <td colSpan={2} className="p-2 text-center text-gray-500 italic">No registers read yet</td>
                    </tr>
                  ) : (
                    Object.entries(modbusRegisters).map(([addr, val]) => (
                      <tr key={addr} className="hover:bg-gray-800/10">
                        <td className="p-1 border-r border-gray-800 text-indigo-400 font-semibold">{addr}</td>
                        <td className="p-1 text-emerald-400 font-bold">{val} (0x{val.toString(16).toUpperCase()})</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Logs terminal */}
        <div className="flex-1 p-3 overflow-y-auto font-mono text-[10px] text-gray-400 space-y-2 bg-[#080d1a] scrollbar-thin scrollbar-track-transparent">
          {decoderLogs.map((log, idx) => (
            <div key={idx} className="border-l border-indigo-900 pl-2 leading-relaxed break-all">
              {log}
            </div>
          ))}
        </div>
      </aside>

      {/* BOTTOM PANEL - Hex Inspector & Decoded Frame Details */}
      <section className="col-start-2 row-start-3 bg-[#0b0f19] flex flex-col overflow-hidden border-t border-gray-800">
        <div className="bg-[#111827] px-3 py-1.5 border-b border-gray-800 flex items-center justify-between">
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
            <Settings className="h-3.5 w-3.5 text-indigo-400" /> Frame Analyzer
          </span>
          {selectedPacket && (
            <span className="text-[10px] text-gray-400 font-mono">
              Packet #{selectedPacket.id} | Timestamp: {formatTimestamp(selectedPacket.timestamp_ns)} | Protocol: {selectedPacket.protocol}
            </span>
          )}
        </div>

        {/* Hex Editor Container */}
        {!selectedPacket ? (
          <div className="flex-1 flex items-center justify-center text-gray-500 italic text-xs">
            Select a packet in the table above to inspect raw hex bytes and decoded telemetry
          </div>
        ) : (
          <div className="flex-1 p-3 overflow-y-auto bg-[#070b14] font-mono text-xs text-gray-300 select-text scrollbar-thin flex flex-col md:flex-row gap-6">
            <div className="flex-1 select-text space-y-1">
              {/* Labels */}
              <div className="grid grid-cols-[100px_350px_1fr] border-b border-gray-800/40 pb-1 mb-2 font-bold text-gray-500 select-none">
                <div>OFFSET</div>
                <div>HEX DUMP (16-BYTE BLOCK)</div>
                <div>ASCII</div>
              </div>
              
              {/* Hex Dump Output */}
              {hexDumpRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-[100px_350px_1fr] hover:bg-gray-800/10 rounded px-0.5">
                  <div className="text-indigo-400 select-none font-semibold">{row.offset}</div>
                  <div className="text-gray-300 tracking-wider font-semibold whitespace-pre">{row.hexStr}</div>
                  <div className="text-emerald-400 font-semibold">{row.asciiStr}</div>
                </div>
              ))}
            </div>

            {/* Selected Packet Anomalies Inspector */}
            {(() => {
              const packetAnomalies = anomalies.filter(a => a.packet_id === selectedPacket.id);
              if (packetAnomalies.length === 0) return null;
              return (
                <div className="w-full md:w-[320px] border-t md:border-t-0 md:border-l border-gray-850 pt-4 md:pt-0 md:pl-4 space-y-2 select-text text-xs">
                  <span className="font-bold text-rose-400 uppercase tracking-wider block">Detected Anomalies ({packetAnomalies.length})</span>
                  <div className="space-y-2 overflow-y-auto max-h-[140px] pr-1">
                    {packetAnomalies.map((anom, aIdx) => (
                      <div key={aIdx} className={`p-2 rounded border font-sans ${anom.severity === "error" ? "bg-rose-950/20 border-rose-900/60 text-rose-300" : "bg-amber-950/20 border-amber-900/60 text-amber-300"}`}>
                        <div className="font-bold flex items-center gap-1.5 mb-0.5">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {anom.anomaly_type} ({anom.severity})
                        </div>
                        <p className="text-[10px] text-gray-300 leading-normal">{anom.description}</p>
                        <div className="text-[9px] text-indigo-400 mt-1 border-t border-gray-800/40 pt-1">
                          <strong>Fix:</strong> {anom.suggested_fix}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Dynamic visual display for selected packet under the active decoder */}
            {packetDecodedResult && (
              <div className="w-full md:w-[360px] border-t md:border-t-0 md:border-l border-gray-800/80 pt-4 md:pt-0 md:pl-6 space-y-3 select-none">
                <h4 className="text-xs uppercase font-bold text-gray-400 tracking-wider">Decoded Frame Details</h4>
                
                {"Nmea" in packetDecodedResult && (
                  <div className="space-y-2 text-[11px] bg-indigo-950/20 border border-indigo-900/40 p-3 rounded">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Sentence:</span>
                      <span className="text-indigo-400 font-bold">{packetDecodedResult.Nmea.sentence_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Checksum Status:</span>
                      <span className={`font-semibold ${packetDecodedResult.Nmea.valid_checksum ? "text-emerald-400" : "text-rose-400"}`}>
                        {packetDecodedResult.Nmea.valid_checksum ? "Valid Checksum" : "Invalid Checksum"}
                      </span>
                    </div>
                    <div className="border-t border-gray-800/60 my-2"></div>
                    <div className="space-y-1 overflow-y-auto max-h-[100px]">
                      {Object.entries(packetDecodedResult.Nmea.fields).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2">
                          <span className="text-gray-500 capitalize">{k.replace("_", " ")}:</span>
                          <span className="text-indigo-200 font-medium break-all text-right">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {"Modbus" in packetDecodedResult && (
                  <div className="space-y-2 text-[11px] bg-orange-950/20 border border-orange-900/40 p-3 rounded">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Device Address:</span>
                      <span className="text-orange-400 font-bold">{packetDecodedResult.Modbus.device_addr}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Function:</span>
                      <span className="text-orange-300 font-semibold">{packetDecodedResult.Modbus.function_name} ({packetDecodedResult.Modbus.function_code.toString(16).padStart(2, "0").toUpperCase()})</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">CRC Status:</span>
                      <span className={`font-semibold ${packetDecodedResult.Modbus.valid_crc ? "text-emerald-400" : "text-rose-400"}`}>
                        {packetDecodedResult.Modbus.valid_crc ? "Valid" : "CRC Error"}
                      </span>
                    </div>
                    {packetDecodedResult.Modbus.is_error && (
                      <div className="flex justify-between bg-rose-950/30 px-1.5 py-0.5 rounded border border-rose-900/40 mt-1">
                        <span className="text-rose-400 font-medium">Exception Code:</span>
                        <span className="text-rose-400 font-bold font-mono">{packetDecodedResult.Modbus.error_code}</span>
                      </div>
                    )}
                    <div className="border-t border-gray-800/60 my-2"></div>
                    <div className="space-y-1">
                      <span className="text-gray-500 block mb-1 font-semibold">Decoded Register Data:</span>
                      <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">
                        {packetDecodedResult.Modbus.registers.map((reg, idx) => (
                          <span key={idx} className="bg-gray-900 text-orange-400 border border-gray-800 rounded px-1.5 py-0.5 text-[9px] font-mono">
                            [{idx}]: {reg} (0x{reg.toString(16).toUpperCase()})
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {"At" in packetDecodedResult && (
                  <div className="space-y-2 text-[11px] bg-sky-950/20 border border-sky-900/40 p-3 rounded">
                    {packetDecodedResult.At.is_command ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Command:</span>
                          <span className="text-sky-400 font-bold">{packetDecodedResult.At.command_name}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Type:</span>
                          <span className="text-sky-300 font-semibold">{packetDecodedResult.At.command_type}</span>
                        </div>
                        <div className="text-[10px] text-gray-400 italic bg-gray-900/50 p-1.5 rounded border border-gray-800/40">
                          {packetDecodedResult.At.description}
                        </div>
                        <div className="border-t border-gray-800/60 my-2"></div>
                        <div className="space-y-1">
                          <span className="text-gray-500 font-semibold block">Parameters:</span>
                          <div className="flex flex-wrap gap-1">
                            {packetDecodedResult.At.parameters.length === 0 ? (
                              <span className="text-gray-600 italic">None</span>
                            ) : (
                              packetDecodedResult.At.parameters.map((p, i) => (
                                <span key={i} className="bg-gray-900 text-sky-300 border border-gray-800 rounded px-1.5 py-0.2 font-mono">
                                  {p}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                        <div className="flex justify-between text-[10px] pt-1">
                          <span className="text-gray-500">Expected Response:</span>
                          <span className="text-emerald-400 font-medium">{packetDecodedResult.At.expected_response}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Response Status:</span>
                          <span className={`font-bold ${packetDecodedResult.At.response_status === "OK" ? "text-emerald-400" : "text-rose-400"}`}>
                            {packetDecodedResult.At.response_status}
                          </span>
                        </div>
                        <div className="border-t border-gray-800/60 my-2"></div>
                        <div className="space-y-1">
                          <span className="text-gray-500 font-semibold">Response Parameters / Data:</span>
                          <div className="bg-gray-900 text-sky-200 p-2 rounded border border-gray-800 font-mono text-[10px] break-all select-text">
                            {packetDecodedResult.At.parameters.join(", ")}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {!packetDecodedResult && decodedDetails && (
              <div className="w-full md:w-[320px] border-t md:border-t-0 md:border-l border-gray-800/80 pt-4 md:pt-0 md:pl-6 space-y-3 select-none">
                <h4 className="text-xs uppercase font-bold text-gray-400 tracking-wider">Decoded Frame Details</h4>
                
                {selectedPacket.protocol === "SPI" && (
                  <div className="space-y-2 text-[11px] bg-indigo-950/20 border border-indigo-900/40 p-3 rounded">
                    <div className="flex justify-between"><span className="text-gray-500">CS Channel:</span> <span className="text-indigo-400 font-semibold">CH{decodedDetails.cs_channel}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">SPI Mode:</span> <span className="text-indigo-400 font-semibold">Mode {decodedDetails.mode}</span></div>
                    <div className="border-t border-gray-800/60 my-2"></div>
                    <div className="space-y-1">
                      <span className="text-gray-500 block mb-1 font-semibold">MOSI Bytes:</span>
                      <code className="text-emerald-400 break-all select-text font-bold">
                        {decodedDetails.mosi_bytes.map((b: number) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}
                      </code>
                    </div>
                    <div className="border-t border-gray-800/60 my-2"></div>
                    <div className="space-y-1">
                      <span className="text-gray-500 block mb-1 font-semibold font-mono">MISO Bytes:</span>
                      <code className="text-teal-400 break-all select-text font-bold">
                        {decodedDetails.miso_bytes.map((b: number) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}
                      </code>
                    </div>
                  </div>
                )}
                
                {selectedPacket.protocol === "I2C" && (
                  <div className="space-y-2 text-[11px] bg-orange-950/20 border border-orange-900/40 p-3 rounded">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Device Address:</span> 
                      <span className="text-orange-400 font-semibold">0x{decodedDetails.address.toString(16).toUpperCase()} ({decodedDetails.address})</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Direction:</span> 
                      <span className={`font-semibold ${decodedDetails.direction === "Read" ? "text-yellow-400" : "text-orange-400"}`}>
                        {decodedDetails.direction}
                      </span>
                    </div>
                    {decodedDetails.error && (
                      <div className="flex justify-between bg-rose-950/30 px-1.5 py-0.5 rounded border border-rose-900/40 mt-1">
                        <span className="text-rose-400 font-medium">Error:</span> 
                        <span className="text-rose-400 font-bold font-mono text-[10px]">{decodedDetails.error}</span>
                      </div>
                    )}
                    <div className="border-t border-gray-800/60 my-2"></div>
                    <div className="space-y-1">
                      <span className="text-gray-500 block mb-1 font-semibold">Data Bytes:</span>
                      <code className="text-orange-400 break-all select-text font-bold">
                        {decodedDetails.data_bytes.map((b: number) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}
                      </code>
                    </div>
                    <div className="border-t border-gray-800/60 my-2"></div>
                    <div className="space-y-1">
                      <span className="text-gray-500 block mb-1 font-semibold">Acknowledge bits (ACK/NACK):</span>
                      <div className="flex gap-1 overflow-x-auto py-0.5">
                        {decodedDetails.ack_flags.map((ack: boolean, idx: number) => (
                          <span key={idx} className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${ack ? "bg-emerald-950/80 text-emerald-400 border border-emerald-900" : "bg-rose-950/80 text-rose-400 border border-rose-900"}`} title={ack ? "ACK" : "NACK"}>
                            {ack ? "ACK" : "NACK"}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

    </div>
  );
}

export default App;
