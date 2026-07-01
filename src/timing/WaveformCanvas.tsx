import React, { useRef, useEffect, useState, useMemo } from "react";
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Minimize2, 
  MousePointer, 
  Hand,
  Sparkles,
  Zap,
  Info
} from "lucide-react";
import { TimingEngine, Viewport } from "./TimingEngine";

interface WaveformCanvasProps {
  packets: any[];
  selectedPacket: any | null;
  onSelectPacket: (packet: any) => void;
  // Jump trigger
  jumpTimestamp: number | null;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  packets,
  selectedPacket,
  onSelectPacket,
  jumpTimestamp,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Generate waveform data from packets
  const waveformData = useMemo(() => {
    return TimingEngine.generateWaveformDataFromPackets(packets);
  }, [packets]);

  // Viewport State
  const [viewport, setViewport] = useState<Viewport>({
    startTime_ns: 0,
    endTime_ns: 10000000, // 10 ms default
    pixelsPerNs: 0.0001,
  });

  // Interaction Mode: "pan" | "select"
  const [interactionMode, setInteractionMode] = useState<"pan" | "select">("pan");

  // Selection state (time range in ns)
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);

  // Measurement Markers (time in ns)
  const [markerA, setMarkerA] = useState<number | null>(null);
  const [markerB, setMarkerB] = useState<number | null>(null);
  const [draggingMarker, setDraggingMarker] = useState<"A" | "B" | null>(null);

  // Mouse hover state
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverChannel, setHoverChannel] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    channel: string;
  } | null>(null);

  // Measurements overlay state
  const [measurementResult, setMeasurementResult] = useState<{
    type: "period" | "baud";
    channel: string;
    value: string;
    details: string;
  } | null>(null);

  // Define channels and labels
  const channels = [
    { name: "UART_TX", label: "UART TX", color: "#3b82f6" },
    { name: "UART_RX", label: "UART RX", color: "#60a5fa" },
    { name: "SPI_CS", label: "SPI CS", color: "#c084fc" },
    { name: "SPI_CLK", label: "SPI CLK", color: "#9ca3af" },
    { name: "SPI_MOSI", label: "SPI MOSI", color: "#10b981" },
    { name: "SPI_MISO", label: "SPI MISO", color: "#14b8a6" },
    { name: "I2C_SDA", label: "I2C SDA", color: "#f97316" },
    { name: "I2C_SCL", label: "I2C SCL", color: "#eab308" },
  ];

  const LANE_HEIGHT = 65;
  const LANE_SPACING = 15;
  const RULER_HEIGHT = 40;
  const LABEL_WIDTH = 120;

  // Zoom to fit all packets
  const handleFitAll = () => {
    if (packets.length === 0) {
      setViewport({ startTime_ns: 0, endTime_ns: 10000000, pixelsPerNs: 0.0001 });
      return;
    }
    const timestamps = packets.map(p => p.timestamp_ns);
    const minT = Math.min(...timestamps);
    const maxT = Math.max(...timestamps);
    // add padding
    const duration = maxT - minT || 10000000;
    const padding = duration * 0.1;
    const start = Math.max(0, minT - padding);
    const end = maxT + padding + 10000000; // ensure space at end
    const canvas = canvasRef.current;
    const drawWidth = canvas ? canvas.width - LABEL_WIDTH : 800;
    setViewport({
      startTime_ns: start,
      endTime_ns: end,
      pixelsPerNs: drawWidth / (end - start),
    });
    setSelection(null);
  };

  // Run fit all on initial render or when packets change
  useEffect(() => {
    handleFitAll();
  }, [packets]);

  // Handle jump timestamp from outer packet selection
  useEffect(() => {
    if (jumpTimestamp !== null) {
      const canvas = canvasRef.current;
      const drawWidth = canvas ? canvas.width - LABEL_WIDTH : 800;
      const duration = viewport.endTime_ns - viewport.startTime_ns;
      const newStart = Math.max(0, jumpTimestamp - duration / 2);
      setViewport({
        startTime_ns: newStart,
        endTime_ns: newStart + duration,
        pixelsPerNs: drawWidth / duration,
      });
      // Place Marker A at the packet timestamp
      setMarkerA(jumpTimestamp);
    }
  }, [jumpTimestamp]);

  // Adjust zoom level
  const adjustZoom = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drawWidth = canvas.width - LABEL_WIDTH;
    const centerTime = (viewport.startTime_ns + viewport.endTime_ns) / 2;
    const newDuration = (viewport.endTime_ns - viewport.startTime_ns) * factor;
    const newStart = Math.max(0, centerTime - newDuration / 2);
    setViewport({
      startTime_ns: newStart,
      endTime_ns: newStart + newDuration,
      pixelsPerNs: drawWidth / newDuration,
    });
  };

  const handleZoomToSelection = () => {
    if (!selection) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drawWidth = canvas.width - LABEL_WIDTH;
    const duration = Math.abs(selection.end - selection.start) || 1000;
    setViewport({
      startTime_ns: Math.min(selection.start, selection.end),
      endTime_ns: Math.max(selection.start, selection.end),
      pixelsPerNs: drawWidth / duration,
    });
    setSelection(null);
  };

  // Nice time string formatter
  const formatTimeNs = (ns: number) => {
    if (ns < 1000) return `${ns.toFixed(0)} ns`;
    if (ns < 1000000) return `${(ns / 1000).toFixed(2)} µs`;
    if (ns < 1000000000) return `${(ns / 1000000).toFixed(2)} ms`;
    return `${(ns / 1000000000).toFixed(3)} s`;
  };

  // Format zoom div level
  const getZoomDivLabel = () => {
    const duration = viewport.endTime_ns - viewport.startTime_ns;
    const divDuration = duration / 10;
    return formatTimeNs(divDuration) + " / div";
  };

  // Auto-measure period
  const handleMeasurePeriod = (channelName: string) => {
    const channelTrans = waveformData.transitions[channelName] || [];
    const inViewTrans = channelTrans.filter(
      (t) => t.t >= viewport.startTime_ns && t.t <= viewport.endTime_ns
    );

    if (inViewTrans.length < 3) {
      setMeasurementResult({
        type: "period",
        channel: channelName,
        value: "Insufficient Transitions",
        details: "At least 3 transitions in view are required to compute pulse period.",
      });
      return;
    }

    // Measure period between similar edges (e.g. rising to rising or falling to falling)
    // Simply take differences between alternate transitions
    let totalPeriod = 0;
    let counts = 0;
    for (let i = 2; i < inViewTrans.length; i += 2) {
      const p = inViewTrans[i].t - inViewTrans[i - 2].t;
      totalPeriod += p;
      counts++;
    }

    const avgPeriod = totalPeriod / counts;
    const freqHz = 1_000_000_000 / avgPeriod;

    let freqStr = "";
    if (freqHz >= 1_000_000) freqStr = `${(freqHz / 1_000_000).toFixed(2)} MHz`;
    else if (freqHz >= 1000) freqStr = `${(freqHz / 1000).toFixed(2)} kHz`;
    else freqStr = `${freqHz.toFixed(1)} Hz`;

    setMeasurementResult({
      type: "period",
      channel: channelName,
      value: `${formatTimeNs(avgPeriod)} (${freqStr})`,
      details: `Calculated average from ${counts} cycles in view.`,
    });
  };

  // Baud rate helper
  const handleMeasureBaud = (channelName: string) => {
    const channelTrans = waveformData.transitions[channelName] || [];
    const inViewTrans = channelTrans.filter(
      (t) => t.t >= viewport.startTime_ns && t.t <= viewport.endTime_ns
    );

    if (inViewTrans.length < 2) {
      setMeasurementResult({
        type: "baud",
        channel: channelName,
        value: "Unable to detect",
        details: "Requires at least 2 transitions in view.",
      });
      return;
    }

    // Find the minimum duration between consecutive transitions
    let minDiff = Infinity;
    for (let i = 1; i < inViewTrans.length; i++) {
      const diff = inViewTrans[i].t - inViewTrans[i - 1].t;
      if (diff > 500 && diff < minDiff) { // ignore glitch/sub-500ns changes
        minDiff = diff;
      }
    }

    if (minDiff === Infinity) {
      setMeasurementResult({
        type: "baud",
        channel: channelName,
        value: "Unknown",
        details: "No stable transition widths found.",
      });
      return;
    }

    const estimatedBaud = Math.round(1_000_000_000 / minDiff);
    // Find closest standard baud rate
    const standardBauds = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
    const closest = standardBauds.reduce((prev, curr) => 
      Math.abs(curr - estimatedBaud) < Math.abs(prev - estimatedBaud) ? curr : prev
    );

    setMeasurementResult({
      type: "baud",
      channel: channelName,
      value: `${closest} bps`,
      details: `Detected min pulse width of ${formatTimeNs(minDiff)}. Calculated ${estimatedBaud.toLocaleString()} bps.`,
    });
  };

  // Drag variables
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, startTime: 0, selectionStart: 0 });

  // Canvas Drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas if needed
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    const { startTime_ns, endTime_ns, pixelsPerNs } = viewport;
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = "#070b14";
    ctx.fillRect(0, 0, width, height);

    // Draw grid & time ruler
    const duration = endTime_ns - startTime_ns;
    
    // Find grid division size
    const idealDiv = duration / 10;
    const power = Math.pow(10, Math.floor(Math.log10(idealDiv)));
    const ratio = idealDiv / power;
    let step = power;
    if (ratio < 1.5) step = power;
    else if (ratio < 3.5) step = 2 * power;
    else if (ratio < 7.5) step = 5 * power;
    else step = 10 * power;

    // Gridlines starting time
    const startGridTime = Math.floor(startTime_ns / step) * step;

    // Draw Grid Vertical Lines & Text labels
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#64748b";
    ctx.font = "9px monospace";

    for (let t = startGridTime; t <= endTime_ns; t += step) {
      if (t < startTime_ns) continue;
      const x = LABEL_WIDTH + (t - startTime_ns) * pixelsPerNs;
      
      // Vertical grid lines
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();

      // Tick markers on ruler
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 10);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.strokeStyle = "#475569";
      ctx.stroke();
      ctx.strokeStyle = "#1e293b";

      // Time labels
      ctx.textAlign = "center";
      ctx.fillText(formatTimeNs(t), x, RULER_HEIGHT - 15);
    }

    // Draw Ruler bottom border
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT);
    ctx.lineTo(width, RULER_HEIGHT);
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw Channel lanes
    channels.forEach((ch, idx) => {
      const laneY = RULER_HEIGHT + idx * (LANE_HEIGHT + LANE_SPACING) + LANE_SPACING;

      // Draw Channel Label Background
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, laneY - 5, LABEL_WIDTH, LANE_HEIGHT + 5);
      
      // Border separation
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH, laneY - 5);
      ctx.lineTo(LABEL_WIDTH, laneY + LANE_HEIGHT);
      ctx.strokeStyle = "#334155";
      ctx.stroke();

      // Channel Text
      ctx.fillStyle = hoverChannel === ch.name ? "#f8fafc" : "#94a3b8";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "left";
      ctx.fillText(ch.label, 10, laneY + LANE_HEIGHT / 2 + 3);

      // Lane guide/baseline (dashed low level line)
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(LABEL_WIDTH, laneY + LANE_HEIGHT - 10);
      ctx.lineTo(width, laneY + LANE_HEIGHT - 10);
      ctx.strokeStyle = "#1e293b";
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw digital trace
      const transitions = waveformData.transitions[ch.name] || [];
      const viewTrans = TimingEngine.getTransitionsInView(transitions, viewport);

      if (viewTrans.length > 0) {
        ctx.strokeStyle = ch.color;
        ctx.lineWidth = 2;
        ctx.beginPath();

        let prevX = LABEL_WIDTH + viewTrans[0].x;
        let prevY = laneY + (viewTrans[0].v === 1 ? 10 : LANE_HEIGHT - 10);
        ctx.moveTo(prevX, prevY);

        for (let i = 1; i < viewTrans.length; i++) {
          const x = LABEL_WIDTH + viewTrans[i].x;
          // horizontal line to new transition x
          ctx.lineTo(x, prevY);
          // vertical transition line
          const newY = laneY + (viewTrans[i].v === 1 ? 10 : LANE_HEIGHT - 10);
          ctx.lineTo(x, newY);
          
          prevX = x;
          prevY = newY;
        }
        ctx.stroke();
      }

      // Draw Decoded Periods (UART, SPI, I2C data frames overlay)
      const periods = waveformData.decodedPeriods[ch.name] || [];
      const visiblePeriods = periods.filter(
        (p) => p.endTime_ns >= startTime_ns && p.startTime_ns <= endTime_ns
      );

      visiblePeriods.forEach((p) => {
        const xStart = Math.max(LABEL_WIDTH, LABEL_WIDTH + (p.startTime_ns - startTime_ns) * pixelsPerNs);
        const xEnd = Math.min(width, LABEL_WIDTH + (p.endTime_ns - startTime_ns) * pixelsPerNs);
        const boxWidth = xEnd - xStart;

        if (boxWidth > 4) {
          // Color coding based on type
          let bgColor = "rgba(59, 130, 246, 0.2)"; // blue default
          let borderColor = "#3b82f6";
          let textColor = "#93c5fd";

          if (p.type === "spi_mosi") {
            bgColor = "rgba(16, 185, 129, 0.15)";
            borderColor = "#10b981";
            textColor = "#a7f3d0";
          } else if (p.type === "spi_miso") {
            bgColor = "rgba(20, 184, 166, 0.15)";
            borderColor = "#14b8a6";
            textColor = "#99f6e4";
          } else if (p.type === "i2c_addr") {
            bgColor = "rgba(249, 115, 22, 0.2)";
            borderColor = "#f97316";
            textColor = "#ffedd5";
          } else if (p.type === "i2c_data") {
            bgColor = "rgba(234, 179, 8, 0.15)";
            borderColor = "#eab308";
            textColor = "#fef9c3";
          } else if (p.type === "i2c_start" || p.type === "i2c_stop") {
            // Draw START/STOP triangles
            ctx.fillStyle = p.type === "i2c_start" ? "#22c55e" : "#ef4444";
            ctx.beginPath();
            const centerX = xStart + boxWidth / 2;
            const centerY = laneY + LANE_HEIGHT / 2;
            ctx.moveTo(centerX - 6, centerY + 6);
            ctx.lineTo(centerX + 6, centerY + 6);
            ctx.lineTo(centerX, centerY - 6);
            ctx.closePath();
            ctx.fill();
            return;
          }

          // Draw hexagon/box for data period
          ctx.fillStyle = bgColor;
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 1;

          ctx.beginPath();
          // Draw hexagon shaped data blocks
          const pad = Math.min(6, boxWidth / 2);
          ctx.moveTo(xStart + pad, laneY + 5);
          ctx.lineTo(xEnd - pad, laneY + 5);
          ctx.lineTo(xEnd, laneY + LANE_HEIGHT / 2);
          ctx.lineTo(xEnd - pad, laneY + LANE_HEIGHT - 5);
          ctx.lineTo(xStart + pad, laneY + LANE_HEIGHT - 5);
          ctx.lineTo(xStart, laneY + LANE_HEIGHT / 2);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          // Render Text Label inside box
          ctx.fillStyle = textColor;
          ctx.font = "bold 10px monospace";
          ctx.textAlign = "center";
          
          // Truncate text if it doesn't fit
          const maxTextWidth = boxWidth - 8;
          let label = p.label;
          if (ctx.measureText(label).width > maxTextWidth) {
            label = "..";
          }
          ctx.fillText(label, xStart + boxWidth / 2, laneY + LANE_HEIGHT / 2 + 4);
        }
      });
    });

    // Draw selected range / blue selection highlight
    if (selection) {
      const selXStart = LABEL_WIDTH + (selection.start - startTime_ns) * pixelsPerNs;
      const selXEnd = LABEL_WIDTH + (selection.end - startTime_ns) * pixelsPerNs;
      ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      ctx.fillRect(selXStart, RULER_HEIGHT, selXEnd - selXStart, height - RULER_HEIGHT);
      ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(selXStart, RULER_HEIGHT, selXEnd - selXStart, height - RULER_HEIGHT);
    }

    // Draw Marker A
    if (markerA !== null && markerA >= startTime_ns && markerA <= endTime_ns) {
      const x = LABEL_WIDTH + (markerA - startTime_ns) * pixelsPerNs;
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw tag at top
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(x - 10, RULER_HEIGHT - 10, 20, 10);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("A", x, RULER_HEIGHT - 2);
    }

    // Draw Marker B
    if (markerB !== null && markerB >= startTime_ns && markerB <= endTime_ns) {
      const x = LABEL_WIDTH + (markerB - startTime_ns) * pixelsPerNs;
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw tag at top
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(x - 10, RULER_HEIGHT - 10, 20, 10);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("B", x, RULER_HEIGHT - 2);
    }

    // Draw Selected Packet indicator
    if (selectedPacket && selectedPacket.timestamp_ns >= startTime_ns && selectedPacket.timestamp_ns <= endTime_ns) {
      const x = LABEL_WIDTH + (selectedPacket.timestamp_ns - startTime_ns) * pixelsPerNs;
      ctx.strokeStyle = "rgba(234, 179, 8, 0.6)"; // golden yellow
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Hover Cursor line and tooltip
    if (hoverTime !== null && hoverTime >= startTime_ns && hoverTime <= endTime_ns && mousePos && mousePos.x >= LABEL_WIDTH) {
      ctx.strokeStyle = "rgba(248, 250, 252, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mousePos.x, RULER_HEIGHT);
      ctx.lineTo(mousePos.x, height);
      ctx.stroke();

      // Tooltip box
      const timeStr = formatTimeNs(hoverTime);
      ctx.font = "10px monospace";
      const txtWidth = ctx.measureText(timeStr).width;
      const boxW = txtWidth + 12;
      const boxH = 20;

      let boxX = mousePos.x + 10;
      if (boxX + boxW > width) boxX = mousePos.x - boxW - 10;

      ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(boxX, mousePos.y - 30, boxW, boxH, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#f1f5f9";
      ctx.textAlign = "left";
      ctx.fillText(timeStr, boxX + 6, mousePos.y - 16);
    }
  }, [viewport, waveformData, hoverTime, hoverChannel, mousePos, selection, markerA, markerB, selectedPacket]);

  // Event Handlers for interactive behaviors
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (e.button === 2) {
      // Right-click handles context menu
      return;
    }

    // Check if clicking near Marker A or B handles in the ruler
    const { startTime_ns, pixelsPerNs } = viewport;
    
    if (y < RULER_HEIGHT) {
      if (markerA !== null) {
        const markerAx = LABEL_WIDTH + (markerA - startTime_ns) * pixelsPerNs;
        if (Math.abs(x - markerAx) < 12) {
          setDraggingMarker("A");
          return;
        }
      }
      if (markerB !== null) {
        const markerBx = LABEL_WIDTH + (markerB - startTime_ns) * pixelsPerNs;
        if (Math.abs(x - markerBx) < 12) {
          setDraggingMarker("B");
          return;
        }
      }

      // click ruler to place marker
      const timeClicked = startTime_ns + (x - LABEL_WIDTH) / pixelsPerNs;
      if (markerA === null) {
        setMarkerA(timeClicked);
      } else if (markerB === null) {
        setMarkerB(timeClicked);
      } else {
        // move closest
        const distA = Math.abs(timeClicked - markerA);
        const distB = Math.abs(timeClicked - markerB);
        if (distA < distB) setMarkerA(timeClicked);
        else setMarkerB(timeClicked);
      }
      return;
    }

    // Bidirectional Linking: Click near a decoded block to find matching packet
    if (x >= LABEL_WIDTH) {
      const clickedTime = startTime_ns + (x - LABEL_WIDTH) / pixelsPerNs;
      
      // Find packet closest in time
      if (packets.length > 0) {
        let closestPack = packets[0];
        let minDiff = Math.abs(packets[0].timestamp_ns - clickedTime);
        for (const p of packets) {
          const diff = Math.abs(p.timestamp_ns - clickedTime);
          if (diff < minDiff) {
            minDiff = diff;
            closestPack = p;
          }
        }
        // If within 0.1ms, select it
        if (minDiff < 5000000) {
          onSelectPacket(closestPack);
        }
      }
    }

    isDragging.current = true;
    dragStart.current = {
      x,
      y,
      startTime: viewport.startTime_ns,
      selectionStart: startTime_ns + (x - LABEL_WIDTH) / pixelsPerNs,
    };

    if (interactionMode === "select" || e.shiftKey) {
      const clickTime = startTime_ns + (x - LABEL_WIDTH) / pixelsPerNs;
      setSelection({ start: clickTime, end: clickTime });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setMousePos({ x, y });

    const { startTime_ns, endTime_ns, pixelsPerNs } = viewport;
    const timeAtMouse = startTime_ns + (x - LABEL_WIDTH) / pixelsPerNs;
    setHoverTime(timeAtMouse >= 0 ? timeAtMouse : null);

    // Identify lane under mouse
    if (y >= RULER_HEIGHT) {
      const rawIdx = Math.floor((y - RULER_HEIGHT - LANE_SPACING) / (LANE_HEIGHT + LANE_SPACING));
      if (rawIdx >= 0 && rawIdx < channels.length) {
        setHoverChannel(channels[rawIdx].name);
      } else {
        setHoverChannel(null);
      }
    } else {
      setHoverChannel(null);
    }

    // Dragging Markers
    if (draggingMarker === "A" && markerA !== null) {
      setMarkerA(Math.max(0, timeAtMouse));
      return;
    }
    if (draggingMarker === "B" && markerB !== null) {
      setMarkerB(Math.max(0, timeAtMouse));
      return;
    }

    if (!isDragging.current) return;

    const dx = x - dragStart.current.x;
    
    if (interactionMode === "select" || e.shiftKey) {
      setSelection({
        start: dragStart.current.selectionStart,
        end: timeAtMouse,
      });
    } else {
      // Pan mode
      const dt = dx / pixelsPerNs;
      const newStart = Math.max(0, dragStart.current.startTime - dt);
      const duration = endTime_ns - startTime_ns;
      setViewport({
        startTime_ns: newStart,
        endTime_ns: newStart + duration,
        pixelsPerNs,
      });
    }
  };

  const handleMouseUp = () => {
    isDragging.current = false;
    setDraggingMarker(null);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - LABEL_WIDTH;

    if (mouseX < 0) return; // ignore zoom when scrolling on labels

    e.preventDefault();

    const { startTime_ns, endTime_ns, pixelsPerNs } = viewport;
    const timeUnderMouse = startTime_ns + mouseX / pixelsPerNs;
    const factor = e.deltaY > 0 ? 1.15 : 0.85;

    const duration = endTime_ns - startTime_ns;
    const newDuration = Math.max(10, duration * factor); // don't zoom in past 10ns

    const drawWidth = canvas.width - LABEL_WIDTH;
    const newStart = Math.max(0, timeUnderMouse - (mouseX / drawWidth) * newDuration);

    setViewport({
      startTime_ns: newStart,
      endTime_ns: newStart + newDuration,
      pixelsPerNs: drawWidth / newDuration,
    });
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;

    if (y >= RULER_HEIGHT) {
      const idx = Math.floor((y - RULER_HEIGHT - LANE_SPACING) / (LANE_HEIGHT + LANE_SPACING));
      if (idx >= 0 && idx < channels.length) {
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          channel: channels[idx].name,
        });
      }
    }
  };

  // Close context menu on click
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  // Compute Delta between Markers
  const markerDelta = useMemo(() => {
    if (markerA === null || markerB === null) return null;
    const diff = Math.abs(markerB - markerA);
    const freqHz = 1_000_000_000 / diff;
    
    let freqStr = "";
    if (freqHz >= 1_000_000) freqStr = `${(freqHz / 1_000_000).toFixed(3)} MHz`;
    else if (freqHz >= 1000) freqStr = `${(freqHz / 1000).toFixed(2)} kHz`;
    else freqStr = `${freqHz.toFixed(1)} Hz`;

    return {
      delta: formatTimeNs(diff),
      frequency: freqStr
    };
  }, [markerA, markerB]);

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-h-0 bg-[#070b14] overflow-hidden text-gray-300">
      {/* Top Toolbar */}
      <div className="bg-slate-900/90 border-b border-gray-800 p-2.5 flex items-center justify-between text-xs gap-3">
        <div className="flex items-center gap-2">
          {/* Interaction Mode Toggle */}
          <button
            onClick={() => setInteractionMode("pan")}
            className={`p-1.5 rounded transition-all flex items-center gap-1 ${
              interactionMode === "pan"
                ? "bg-indigo-600 text-white font-semibold"
                : "bg-gray-800 hover:bg-gray-700 text-gray-400"
            }`}
            title="Pan mode: Drag left/right to scroll timeline"
          >
            <Hand className="h-3.5 w-3.5" />
            <span>Pan</span>
          </button>
          
          <button
            onClick={() => setInteractionMode("select")}
            className={`p-1.5 rounded transition-all flex items-center gap-1 ${
              interactionMode === "select"
                ? "bg-indigo-600 text-white font-semibold"
                : "bg-gray-800 hover:bg-gray-700 text-gray-400"
            }`}
            title="Select mode: Drag to select time range"
          >
            <MousePointer className="h-3.5 w-3.5" />
            <span>Select Range</span>
          </button>

          <span className="h-4 w-px bg-gray-800 mx-1" />

          {/* Zoom controls */}
          <button
            onClick={() => adjustZoom(0.7)}
            className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400"
            title="Zoom In"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => adjustZoom(1.4)}
            className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400"
            title="Zoom Out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleFitAll}
            className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 flex items-center gap-1"
            title="Fit All"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Fit All</span>
          </button>

          {selection && (
            <button
              onClick={handleZoomToSelection}
              className="p-1.5 rounded bg-indigo-950 border border-indigo-700 text-indigo-300 hover:bg-indigo-900 flex items-center gap-1 font-medium"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              <span>Zoom to Selection</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-4 text-[11px] font-mono">
          {/* Zoom division level */}
          <span className="text-gray-500 bg-gray-950/60 px-2 py-1 rounded border border-gray-800/80">
            {getZoomDivLabel()}
          </span>

          {/* Markers overlay */}
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 bg-rose-500 rounded-sm inline-block" />
              <span className="text-gray-400">Marker A:</span>
              <span className="text-gray-200">{markerA !== null ? formatTimeNs(markerA) : "Not Set"}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 bg-blue-500 rounded-sm inline-block" />
              <span className="text-gray-400">Marker B:</span>
              <span className="text-gray-200">{markerB !== null ? formatTimeNs(markerB) : "Not Set"}</span>
            </span>
            {markerDelta && (
              <span className="flex items-center gap-1.5 bg-indigo-950/40 border border-indigo-800/40 px-2 py-0.5 rounded text-indigo-300">
                <span>ΔT:</span>
                <strong>{markerDelta.delta}</strong>
                <span className="text-gray-600">|</span>
                <span>F:</span>
                <strong>{markerDelta.frequency}</strong>
              </span>
            )}
            {(markerA !== null || markerB !== null) && (
              <button 
                onClick={() => { setMarkerA(null); setMarkerB(null); }}
                className="text-gray-500 hover:text-gray-300 text-[10px]"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Canvas Area */}
      <div className="flex-1 relative min-h-0">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={handleContextMenu}
          className="absolute inset-0 w-full h-full cursor-crosshair"
        />

        {/* Right-click Context Menu */}
        {contextMenu && (
          <div
            style={{ top: contextMenu.y, left: contextMenu.x }}
            className="fixed z-50 bg-[#0f172a] border border-gray-800 rounded-md shadow-lg shadow-black/50 py-1 text-xs text-gray-300 w-44 font-mono font-medium"
          >
            <button
              onClick={() => handleMeasurePeriod(contextMenu.channel)}
              className="w-full text-left px-3 py-1.5 hover:bg-indigo-600 hover:text-white flex items-center gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Measure Period
            </button>
            {contextMenu.channel.startsWith("UART") && (
              <button
                onClick={() => handleMeasureBaud(contextMenu.channel)}
                className="w-full text-left px-3 py-1.5 hover:bg-indigo-600 hover:text-white flex items-center gap-1.5"
              >
                <Zap className="h-3.5 w-3.5" />
                Detect Baud Rate
              </button>
            )}
          </div>
        )}

        {/* Measurement Result Dialog Overlay */}
        {measurementResult && (
          <div className="absolute bottom-4 left-4 z-40 bg-indigo-950/90 border border-indigo-500/30 p-3 rounded-lg shadow-lg max-w-sm flex gap-3 text-xs">
            <Info className="h-5 w-5 text-indigo-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="flex justify-between items-center mb-1">
                <span className="font-semibold text-indigo-200">
                  {measurementResult.type === "period" ? "Period Measurement" : "Baud Rate Detection"}
                </span>
                <span className="text-[10px] text-indigo-400 font-mono">
                  {measurementResult.channel}
                </span>
              </div>
              <p className="text-gray-100 font-bold text-sm mb-1">{measurementResult.value}</p>
              <p className="text-gray-400 text-[10px]">{measurementResult.details}</p>
              <button
                onClick={() => setMeasurementResult(null)}
                className="mt-2 bg-indigo-800 hover:bg-indigo-700 text-white font-medium px-2 py-0.5 rounded transition-colors text-[10px]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
