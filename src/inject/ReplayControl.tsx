import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Play, Pause, Square, Sliders, RefreshCw } from 'lucide-react';

interface Capture {
  id: number;
  name: string;
  protocol: string;
  started_at: string;
  ended_at: string | null;
  packet_count: number;
}

interface ReplayState {
  current_packet_index: number;
  total_packets: number;
  elapsed_ms: number;
  status: string; // "Playing", "Paused", "Done"
}

interface ReplayControlProps {
  onCaptureLoaded: (captureId: number) => void;
}

export const ReplayControl: React.FC<ReplayControlProps> = ({ onCaptureLoaded }) => {
  const [capturesList, setCapturesList] = useState<Capture[]>([]);
  const [selectedCapId, setSelectedCapId] = useState<number | null>(null);
  
  // Settings
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1.0);
  const [filterDirection, setFilterDirection] = useState<string>('All');
  const [filterPattern, setFilterPattern] = useState<string>('');

  // Replayer status
  const [replayState, setReplayState] = useState<ReplayState>({
    current_packet_index: 0,
    total_packets: 0,
    elapsed_ms: 0,
    status: 'Done',
  });

  const loadCaptures = async () => {
    try {
      const history = await invoke<Capture[]>('get_captures');
      setCapturesList(history);
      if (history.length > 0 && !selectedCapId) {
        setSelectedCapId(history[0].id);
      }
    } catch (e) {
      console.error('Failed to load captures list:', e);
    }
  };

  useEffect(() => {
    loadCaptures();

    // Listen to replay progress events
    let unlisten: (() => void) | null = null;
    const setupListener = async () => {
      unlisten = await listen<ReplayState>('replay-state-changed', (event) => {
        setReplayState(event.payload);
      });
    };
    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleStartReplay = async () => {
    if (!selectedCapId) return;
    try {
      // Trigger callback to set active capture so the packet list hooks to it
      onCaptureLoaded(selectedCapId);
      
      await invoke('start_replay', {
        captureId: selectedCapId,
        speed: speedMultiplier,
        filterDirection,
        filterPattern,
      });
      setReplayState({
        current_packet_index: 0,
        total_packets: 100, // will be updated immediately by events
        elapsed_ms: 0,
        status: 'Playing'
      });
    } catch (e) {
      alert(`Replay failed to start: ${e}`);
    }
  };

  const handlePauseReplay = async () => {
    try {
      await invoke('pause_replay');
      setReplayState(prev => ({ ...prev, status: 'Paused' }));
    } catch (e) {
      console.error(e);
    }
  };

  const handleResumeReplay = async () => {
    try {
      await invoke('resume_replay');
      setReplayState(prev => ({ ...prev, status: 'Playing' }));
    } catch (e) {
      console.error(e);
    }
  };

  const handleStopReplay = async () => {
    try {
      await invoke('stop_replay');
      setReplayState(prev => ({ ...prev, status: 'Done' }));
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="bg-[#0f172a] border border-gray-800 rounded p-3 text-xs space-y-3">
      <div className="flex items-center justify-between font-semibold border-b border-gray-850 pb-2 text-gray-300">
        <span className="flex items-center gap-1.5"><Sliders className="h-4 w-4 text-indigo-400" /> Traffic Replayer controls</span>
        <button onClick={loadCaptures} className="text-gray-500 hover:text-indigo-400 p-0.5">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Load Cap Dropdown */}
        <div className="space-y-1">
          <span className="text-gray-400 font-medium">Load Capture Session</span>
          <select
            value={selectedCapId || ''}
            onChange={(e) => setSelectedCapId(Number(e.target.value))}
            className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 outline-none text-gray-255 cursor-pointer"
          >
            {capturesList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.protocol})
              </option>
            ))}
          </select>
        </div>

        {/* Speed multiplier */}
        <div className="space-y-1">
          <span className="text-gray-400 font-medium">Speed Multiplier</span>
          <select
            value={speedMultiplier}
            onChange={(e) => setSpeedMultiplier(Number(e.target.value))}
            className="w-full bg-gray-900 border border-gray-800 rounded px-2.5 py-1 outline-none text-gray-255 cursor-pointer"
          >
            <option value={0.5}>0.5x (Slow-mo)</option>
            <option value={1.0}>1x (Real-time)</option>
            <option value={2.0}>2x Speed</option>
            <option value={5.0}>5x Speed</option>
            <option value={10.0}>10x Speed</option>
            <option value={0.0}>Instant (No delays)</option>
          </select>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span className="text-gray-400 font-medium">Replay Filter (Dir)</span>
            <select
              value={filterDirection}
              onChange={(e) => setFilterDirection(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded px-2 py-1 outline-none cursor-pointer"
            >
              <option value="All">All packets</option>
              <option value="TX">Only TX</option>
              <option value="RX">Only RX</option>
            </select>
          </div>
          <div className="space-y-1">
            <span className="text-gray-400 font-medium">Match Pattern</span>
            <input
              type="text"
              value={filterPattern}
              onChange={(e) => setFilterPattern(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded px-2 py-0.5"
              placeholder="e.g. AT or hex"
            />
          </div>
        </div>
      </div>

      {/* Progress Bar & Buttons */}
      <div className="flex flex-col md:flex-row items-center gap-4 pt-1.5 border-t border-gray-850/60">
        <div className="flex items-center gap-1.5">
          {replayState.status === 'Done' ? (
            <button
              onClick={handleStartReplay}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3 py-1.5 rounded flex items-center gap-1"
            >
              <Play className="h-3.5 w-3.5 fill-white" /> Replay
            </button>
          ) : (
            <>
              {replayState.status === 'Playing' ? (
                <button
                  onClick={handlePauseReplay}
                  className="bg-amber-600 hover:bg-amber-500 text-white font-bold px-3 py-1.5 rounded flex items-center gap-1"
                >
                  <Pause className="h-3.5 w-3.5 fill-white" /> Pause
                </button>
              ) : (
                <button
                  onClick={handleResumeReplay}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3 py-1.5 rounded flex items-center gap-1"
                >
                  <Play className="h-3.5 w-3.5 fill-white" /> Resume
                </button>
              )}
              <button
                onClick={handleStopReplay}
                className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-3 py-1.5 rounded flex items-center gap-1"
              >
                <Square className="h-3.5 w-3.5 fill-white" /> Stop
              </button>
            </>
          )}
        </div>

        {/* Progress details */}
        {replayState.status !== 'Done' && (
          <div className="flex-1 flex items-center gap-3 w-full">
            <div className="flex-1 h-3.5 bg-gray-900 border border-gray-800 rounded-full overflow-hidden relative">
              <div
                className="h-full bg-indigo-600 transition-all duration-150"
                style={{
                  width: `${(replayState.current_packet_index / Math.max(1, replayState.total_packets)) * 100}%`,
                }}
              />
              <span className="absolute inset-0 flex items-center justify-center font-bold text-[9px] text-gray-200">
                {Math.round((replayState.current_packet_index / Math.max(1, replayState.total_packets)) * 100)}%
              </span>
            </div>
            <div className="font-mono text-[10px] text-gray-400 whitespace-nowrap">
              Packet {replayState.current_packet_index} / {replayState.total_packets} ({replayState.elapsed_ms}ms)
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
