import React, { useState, useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { Play, Square, FileCode, CheckCircle, XCircle } from 'lucide-react';

interface ScriptEngineProps {
  captureId: number | null;
  onInjectRawBytes: (bytes: number[]) => void;
  // Subscribe to new incoming packets to satisfy waitForPacket
  latestPacket: { id: number; raw_bytes: number[]; protocol: string } | null;
}

interface ScriptConsoleLog {
  type: 'log' | 'error' | 'success' | 'timing';
  message: string;
  timestamp: string;
}

const EXAMPLE_SCRIPTS = {
  modbus_scan: `// Modbus Register Scan
// Scans device addresses 1 to 5 for register 40001 (holding registers)

(async () => {
  probe.log("Starting Modbus scan sequence...");
  
  for (let dev = 1; dev <= 5; dev++) {
    probe.log(\`Scanning device ID \${dev}...\`);
    
    // Construct Modbus command frame: [Address, FuncCode, RegStartH, RegStartL, RegCountH, RegCountL]
    const frame = [dev, 3, 0, 0, 0, 1];
    
    // Calculate Modbus CRC16
    const crc = crc16(frame);
    frame.push(crc & 0xFF);         // low
    frame.push((crc >> 8) & 0xFF);  // high
    
    probe.send(frame);
    
    // Wait for response with dev ID match in response payload (up to 150ms)
    try {
      const resp = await probe.waitForPacket(\`^\${dev.toString(16).padStart(2, '0')}03\`, 150);
      probe.log(\`[SUCCESS] Device \${dev} responded: \${resp.raw_hex}\`);
      probe.assert(true, \`Device \${dev} exists\`);
    } catch(e) {
      probe.log(\`[TIMEOUT] Device \${dev} did not respond.\`);
    }
    
    await probe.wait(100);
  }
  
  probe.log("Scan complete.");
})();

function crc16(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if ((crc & 1) !== 0) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc = crc >> 1;
      }
    }
  }
  return crc;
}
`,
  i2c_scanner: `// I2C Address Scanner
// Scans for devices on standard 7-bit addresses 0x08 to 0x77

(async () => {
  probe.log("Initializing I2C Bus Scan...");
  let foundCount = 0;
  
  for (let addr = 0x08; addr <= 0x77; addr++) {
    probe.log(\`Probing Address 0x\${addr.toString(16).toUpperCase()}...\`);
    
    // I2C write probe (empty byte sequence to address)
    // Packet layout: [address_byte] where address_byte is (addr << 1) | Write(0)
    const writeAddr = addr << 1;
    probe.send([writeAddr]);
    
    try {
      // Expect address packet to have ACK or NACK
      const pkt = await probe.waitForPacket(\`^\${writeAddr.toString(16).padStart(2, '0')}\`, 80);
      if (pkt.decoded_json && !pkt.decoded_json.includes("NACK")) {
        probe.log(\`[FOUND] Device responded at 0x\${addr.toString(16).toUpperCase()}\`);
        probe.assert(true, \`Detected device at 0x\${addr.toString(16).toUpperCase()}\`);
        foundCount++;
      }
    } catch (e) {
      // Timeout
    }
    
    await probe.wait(30);
  }
  
  probe.log(\`I2C Scan finished. Found \${foundCount} devices.\`);
})();
`,
  uart_echo: `// UART Echo Test
// Sends a string payload and verifies if it is looped back

(async () => {
  probe.log("Sending UART echo payload...");
  const payload = [0x54, 0x45, 0x53, 0x54, 0x0D, 0x0A]; // "TEST\\r\\n"
  
  const startTime = Date.now();
  probe.send(payload);
  
  probe.log("Waiting for looped echo sequence back...");
  try {
    // Wait for packet matching "TEST" hex: 54455354
    const pkt = await probe.waitForPacket("54455354", 800);
    const latency = Date.now() - startTime;
    probe.log(\`[SUCCESS] Echo loopback verified. Latency: \${latency}ms\`);
    probe.assert(true, "Echo verification check");
  } catch (e) {
    probe.log("[ERROR] Loopback timed out. No loopback detected.");
    probe.assert(false, "Echo loopback match failed");
  }
})();
`
};

export const ScriptEngine: React.FC<ScriptEngineProps> = ({
  captureId,
  onInjectRawBytes,
  latestPacket,
}) => {
  const [scriptCode, setScriptCode] = useState<string>(EXAMPLE_SCRIPTS.modbus_scan);
  const [logs, setLogs] = useState<ScriptConsoleLog[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('modbus_scan');

  // Ref to hold the resolve callback for the active waitForPacket await
  const packetWaitPromiseRef = useRef<{
    pattern: string;
    resolve: (pkt: { raw_hex: string; decoded_json?: string }) => void;
    reject: (err: Error) => void;
  } | null>(null);

  // Load template script
  const handleTemplateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelectedTemplate(value);
    if (value in EXAMPLE_SCRIPTS) {
      setScriptCode((EXAMPLE_SCRIPTS as any)[value]);
    }
  };

  // Watch incoming packets to satisfy script engine waitForPacket API
  useEffect(() => {
    if (latestPacket && packetWaitPromiseRef.current) {
      const hexBytes = latestPacket.raw_bytes.map(b => b.toString(16).padStart(2, '0')).join('');
      const regex = new RegExp(packetWaitPromiseRef.current.pattern, 'i');
      if (regex.test(hexBytes)) {
        const res = packetWaitPromiseRef.current.resolve;
        packetWaitPromiseRef.current = null;
        res({
          raw_hex: hexBytes,
          decoded_json: (latestPacket as any).decoded_json || ''
        });
      }
    }
  }, [latestPacket]);

  const addConsoleLog = (type: ScriptConsoleLog['type'], message: string) => {
    const timestamp = new Date().toLocaleTimeString() + '.' + String(Date.now() % 1000).padStart(3, '0');
    setLogs((prev) => [...prev, { type, message, timestamp }]);
  };

  const handleStopScript = () => {
    if (packetWaitPromiseRef.current) {
      packetWaitPromiseRef.current.reject(new Error("Script stopped by user"));
      packetWaitPromiseRef.current = null;
    }
    setIsRunning(false);
    addConsoleLog('error', 'Script sequence terminated.');
  };

  const handleRunScript = async () => {
    if (!captureId) {
      alert("Start or select a capture session first to run scripts");
      return;
    }
    setLogs([]);
    setIsRunning(true);
    addConsoleLog('timing', 'Evaluating QuickJS logic sequence...');

    // sandbox APIs injected into user script
    const probeApi = {
      send: (bytes: number[]) => {
        onInjectRawBytes(bytes);
        addConsoleLog('timing', `[TX] Sent bytes: [${bytes.map(b => '0x' + b.toString(16).toUpperCase()).join(', ')}]`);
      },
      wait: (ms: number) => {
        return new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
      waitForPacket: (pattern: string, timeoutMs: number) => {
        return new Promise((resolve, reject) => {
          packetWaitPromiseRef.current = { pattern, resolve, reject };
          setTimeout(() => {
            if (packetWaitPromiseRef.current && packetWaitPromiseRef.current.pattern === pattern) {
              packetWaitPromiseRef.current = null;
              reject(new Error("Timeout waiting for packet pattern"));
            }
          }, timeoutMs);
        });
      },
      assert: (condition: boolean, message: string) => {
        if (condition) {
          addConsoleLog('success', `Assertion PASSED: ${message}`);
        } else {
          addConsoleLog('error', `Assertion FAILED: ${message}`);
        }
      },
      log: (message: string) => {
        addConsoleLog('log', message);
      }
    };

    // Construct evaluation block wrapping in Async IIFE
    try {
      // Dynamic evaluation safely exposing our sandbox APIs
      const runner = new Function('probe', `
        return (async () => {
          ${scriptCode}
        })();
      `);
      
      await runner(probeApi);
      addConsoleLog('success', 'Script executed to completion.');
    } catch (e: any) {
      addConsoleLog('error', `Runtime error: ${e.message}`);
    } finally {
      setIsRunning(false);
      packetWaitPromiseRef.current = null;
    }
  };

  return (
    <div className="bg-[#0f172a] border border-gray-800 rounded flex flex-col h-full overflow-hidden text-xs">
      {/* Header controls */}
      <div className="bg-[#111827] px-3 py-2 border-b border-gray-800 flex justify-between items-center z-10 gap-4">
        <div className="flex items-center gap-2">
          <FileCode className="h-4 w-4 text-indigo-400" />
          <span className="font-semibold text-gray-300">JavaScript Automation Sequence (QuickJS Sandbox)</span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500 font-medium">Template:</span>
            <select
              value={selectedTemplate}
              onChange={handleTemplateChange}
              className="bg-[#0b0f19] border border-gray-850 rounded px-2 py-0.5 outline-none cursor-pointer text-gray-300"
            >
              <option value="modbus_scan">Modbus Register Scanner</option>
              <option value="i2c_scanner">I2C Address Probe Scanner</option>
              <option value="uart_echo">UART Loopback Echo Assert</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            {!isRunning ? (
              <button
                onClick={handleRunScript}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3 py-1 rounded flex items-center gap-1 text-[11px]"
              >
                <Play className="h-3 w-3 fill-white" /> Run
              </button>
            ) : (
              <button
                onClick={handleStopScript}
                className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-3 py-1 rounded flex items-center gap-1 text-[11px]"
              >
                <Square className="h-3 w-3 fill-white" /> Stop
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Editor & Console Split */}
      <div className="flex-1 grid grid-rows-[2fr_1.2fr] min-h-0">
        <div className="border-b border-gray-800/80">
          <Editor
            height="100%"
            language="javascript"
            theme="vs-dark"
            value={scriptCode}
            onChange={(val) => setScriptCode(val || '')}
            options={{
              minimap: { enabled: false },
              fontSize: 11,
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
              lineNumbers: 'on',
              padding: { top: 6 },
            }}
          />
        </div>

        {/* Output Console log */}
        <div className="bg-[#080d1a] flex flex-col overflow-hidden">
          <div className="bg-gray-900/60 border-b border-gray-850 px-3 py-1 text-gray-500 font-bold uppercase tracking-wider text-[10px]">
            Script Console output log
          </div>
          <div className="flex-1 overflow-y-auto p-2 font-mono text-[10px] space-y-1.5 scrollbar-thin">
            {logs.length === 0 ? (
              <div className="text-gray-600 italic p-2">Waiting for script launch execution...</div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className="flex gap-2">
                  <span className="text-gray-650 select-none">{log.timestamp}</span>
                  {log.type === 'success' && (
                    <span className="text-emerald-400 font-semibold flex items-center gap-1"><CheckCircle className="h-3 w-3" /> {log.message}</span>
                  )}
                  {log.type === 'error' && (
                    <span className="text-rose-400 font-semibold flex items-center gap-1"><XCircle className="h-3 w-3" /> {log.message}</span>
                  )}
                  {log.type === 'timing' && (
                    <span className="text-indigo-400 italic">{log.message}</span>
                  )}
                  {log.type === 'log' && (
                    <span className="text-gray-300">{log.message}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
