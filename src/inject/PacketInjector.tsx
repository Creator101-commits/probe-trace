import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Send, Plus, Trash2, Repeat } from 'lucide-react';

interface Preset {
  id: string;
  name: string;
  hexBytes: string;
}

interface PacketInjectorProps {
  captureId: number | null;
  latestReceivedPacketId: number | null;
  onSelectPacketById: (id: number) => void;
}

export const PacketInjector: React.FC<PacketInjectorProps> = ({
  captureId,
  latestReceivedPacketId,
  onSelectPacketById,
}) => {
  const [hexInput, setHexInput] = useState<string>('01 03 00 00 00 02 C4 0B');
  const [asciiPreview, setAsciiPreview] = useState<string>('');
  
  // Repeat settings
  const [repeatMode, setRepeatMode] = useState<boolean>(false);
  const [repeatCount, setRepeatCount] = useState<number>(5);
  const [repeatDelayMs, setRepeatDelayMs] = useState<number>(500);
  const [isSending, setIsSending] = useState<boolean>(false);

  // Response correlation tracking
  const [waitingForResponse, setWaitingForResponse] = useState<boolean>(false);
  const [likelyResponseId, setLikelyResponseId] = useState<number | null>(null);

  // Presets
  const [presets, setPresets] = useState<Preset[]>(() => {
    const saved = localStorage.getItem('probetrace_inject_presets');
    return saved ? JSON.parse(saved) : [
      { id: '1', name: 'Modbus Read Status', hexBytes: '01 03 00 00 00 02 C4 0B' },
      { id: '2', name: 'NMEA Query Position', hexBytes: '24 45 49 47 50 51 2C 47 47 41 2A 32 37' },
      { id: '3', name: 'AT Ping', hexBytes: '41 54 0D 0A' },
    ];
  });
  const [newPresetName, setNewPresetName] = useState<string>('');

  useEffect(() => {
    localStorage.setItem('probetrace_inject_presets', JSON.stringify(presets));
  }, [presets]);

  // Update ASCII preview
  useEffect(() => {
    const cleanHex = hexInput.replace(/[^0-9A-Fa-f]/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes.push(parseInt(cleanHex.substring(i, i + 2), 16));
    }
    const ascii = bytes.map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    setAsciiPreview(ascii);
  }, [hexInput]);

  // Watch for likely response packet
  useEffect(() => {
    if (waitingForResponse && latestReceivedPacketId) {
      // The very next received packet is flagged as likely response
      setLikelyResponseId(latestReceivedPacketId);
      setWaitingForResponse(false);
    }
  }, [latestReceivedPacketId, waitingForResponse]);

  const parseHexToBytes = (hex: string): number[] => {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 2) {
      bytes.push(parseInt(clean.substring(i, i + 2), 16));
    }
    return bytes;
  };

  const transmitPacket = async (bytes: number[]) => {
    if (!captureId) return;
    try {
      await invoke('inject_packet', { bytes, captureId });
      // We set waiting for response immediately
      setWaitingForResponse(true);
      setLikelyResponseId(null);
    } catch (e) {
      console.error('Transmit injection failed:', e);
    }
  };

  const handleSend = async () => {
    if (!captureId) {
      alert('Start or select a capture session first');
      return;
    }
    const bytes = parseHexToBytes(hexInput);
    if (bytes.length === 0) return;

    if (repeatMode) {
      setIsSending(true);
      for (let i = 0; i < repeatCount; i++) {
        await transmitPacket(bytes);
        if (i < repeatCount - 1) {
          await new Promise(resolve => setTimeout(resolve, repeatDelayMs));
        }
      }
      setIsSending(false);
    } else {
      await transmitPacket(bytes);
    }
  };

  const handleSavePreset = () => {
    if (!newPresetName.trim()) return;
    const newPreset: Preset = {
      id: `preset-${Date.now()}`,
      name: newPresetName,
      hexBytes: hexInput,
    };
    setPresets([...presets, newPreset]);
    setNewPresetName('');
  };

  const handleDeletePreset = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPresets(presets.filter(p => p.id !== id));
  };

  return (
    <div className="bg-[#0f172a] border border-gray-800 rounded flex flex-col h-full overflow-hidden text-xs">
      <div className="bg-[#111827] px-3 py-2 border-b border-gray-800 flex justify-between items-center font-semibold text-gray-300">
        <span>Packet Injection Control</span>
        {likelyResponseId && (
          <button
            onClick={() => onSelectPacketById(likelyResponseId)}
            className="bg-emerald-950/60 border border-emerald-800/80 text-emerald-400 font-bold px-2 py-0.5 rounded text-[10px] animate-pulse"
          >
            Likely Response: Packet #{likelyResponseId}
          </button>
        )}
      </div>

      <div className="flex-1 p-3 grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto min-h-0">
        
        {/* Input & Options */}
        <div className="space-y-3 flex flex-col">
          <div className="space-y-1">
            <span className="text-gray-400 font-medium">Hex Stream Input</span>
            <textarea
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded p-2 text-indigo-300 font-mono text-[11px] h-20 outline-none focus:border-indigo-500 uppercase"
              placeholder="00 11 22 AA BB"
            />
          </div>

          <div className="space-y-1">
            <span className="text-gray-400 font-medium">ASCII Live Preview</span>
            <div className="w-full bg-gray-900 border border-gray-850 rounded p-2 text-emerald-400 font-mono select-all break-all min-h-[36px]">
              {asciiPreview || <span className="text-gray-650 italic">None</span>}
            </div>
          </div>

          {/* Repeat mode */}
          <div className="border border-gray-850 rounded p-2.5 bg-gray-900/20 space-y-2">
            <label className="flex items-center gap-1.5 font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={repeatMode}
                onChange={(e) => setRepeatMode(e.target.checked)}
              />
              <Repeat className="h-3.5 w-3.5" /> Repeat Transmission Mode
            </label>
            {repeatMode && (
              <div className="grid grid-cols-2 gap-3 pl-5">
                <div className="space-y-1">
                  <span className="text-gray-500">Count (times)</span>
                  <input
                    type="number"
                    value={repeatCount}
                    onChange={(e) => setRepeatCount(Math.max(1, Number(e.target.value)))}
                    className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-0.5"
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-gray-500">Delay (ms)</span>
                  <input
                    type="number"
                    value={repeatDelayMs}
                    onChange={(e) => setRepeatDelayMs(Math.max(10, Number(e.target.value)))}
                    className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-0.5"
                  />
                </div>
              </div>
            )}
          </div>

          <button
            onClick={handleSend}
            disabled={isSending || !captureId}
            className="w-full mt-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold py-2 rounded flex items-center justify-center gap-1.5 text-xs shadow transition-all duration-150 active:scale-98"
          >
            <Send className="h-4 w-4" />
            {isSending ? `Injecting (${repeatCount} times)...` : 'Send Packet'}
          </button>
        </div>

        {/* Preset Manager */}
        <div className="space-y-2 flex flex-col min-h-0 border-t md:border-t-0 md:border-l border-gray-850/60 md:pl-4">
          <span className="text-gray-400 font-semibold block">Presets & Templates</span>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 outline-none focus:border-indigo-500"
              placeholder="Preset Name..."
            />
            <button
              onClick={handleSavePreset}
              className="bg-indigo-950/80 border border-indigo-900 hover:bg-indigo-900 text-indigo-300 font-bold px-2.5 rounded flex items-center justify-center"
            >
              <Plus className="h-4 w-4" /> Save
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 max-h-[190px] pr-1 mt-1">
            {presets.map((p) => (
              <div
                key={p.id}
                onClick={() => setHexInput(p.hexBytes)}
                className="bg-gray-900/60 border border-gray-850 hover:border-gray-700 hover:bg-gray-800/20 p-2 rounded flex justify-between items-center cursor-pointer font-mono text-[10px]"
              >
                <div className="space-y-0.5">
                  <div className="font-bold text-gray-300 font-sans text-xs">{p.name}</div>
                  <div className="text-gray-500 font-semibold truncate max-w-[200px]">{p.hexBytes}</div>
                </div>
                <button
                  onClick={(e) => handleDeletePreset(p.id, e)}
                  className="text-gray-500 hover:text-rose-400 p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};
