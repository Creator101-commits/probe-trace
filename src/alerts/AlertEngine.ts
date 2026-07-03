export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  // Conditions
  ruleType: 'pattern' | 'length_equals' | 'length_exceeds' | 'byte_offset' | 'delay_exceeds' | 'error_rate';
  pattern?: string; // regex on hex or ASCII
  patternFormat?: 'hex' | 'ascii';
  lengthValue?: number;
  byteOffset?: number;
  byteValue?: number; // hex or dec value
  delayMs?: number;
  errorRatePercentage?: number;

  // Actions
  actionHighlight: boolean;
  actionBeep: boolean;
  actionNotification: boolean;
  actionPanel: boolean;
}

export interface FiredAlert {
  id: string;
  timestamp: number;
  ruleId: string;
  ruleName: string;
  packetId: number;
  packetDescription: string;
}

export const BUILT_IN_RULES: AlertRule[] = [
  {
    id: 'built_in_i2c_nack',
    name: 'Alert on any I2C NACK',
    enabled: true,
    ruleType: 'pattern',
    pattern: 'NACK',
    patternFormat: 'ascii',
    actionHighlight: true,
    actionBeep: true,
    actionNotification: true,
    actionPanel: true,
  },
  {
    id: 'built_in_modbus_error',
    name: 'Alert on Modbus error response',
    enabled: true,
    ruleType: 'pattern',
    pattern: 'Modbus CRC error|is_error":true',
    patternFormat: 'ascii',
    actionHighlight: true,
    actionBeep: true,
    actionNotification: true,
    actionPanel: true,
  },
  {
    id: 'built_in_no_packets',
    name: 'Alert if no packets for 5 seconds',
    enabled: true,
    ruleType: 'delay_exceeds',
    delayMs: 5000,
    actionHighlight: false,
    actionBeep: true,
    actionNotification: true,
    actionPanel: true,
  }
];

export class AlertEngine {
  private rules: AlertRule[] = [];
  private onAlertTriggered: (alert: FiredAlert, rule: AlertRule) => void;
  private audioCtx: AudioContext | null = null;
  private lastPacketTimestamp: number = Date.now();
  private packetTimestamps: number[] = [];
  private errorPacketsCount = 0;

  constructor(
    initialRules: AlertRule[],
    onAlertTriggered: (alert: FiredAlert, rule: AlertRule) => void
  ) {
    this.rules = initialRules;
    this.onAlertTriggered = onAlertTriggered;

    // Start background check for packet delays
    setInterval(() => this.checkInactiveTimeout(), 1000);
  }

  public updateRules(rules: AlertRule[]) {
    this.rules = rules;
  }

  public resetStats() {
    this.packetTimestamps = [];
    this.errorPacketsCount = 0;
    this.lastPacketTimestamp = Date.now();
  }

  public registerPacketReceipt() {
    this.lastPacketTimestamp = Date.now();
  }

  private checkInactiveTimeout() {
    const now = Date.now();
    const idleMs = now - this.lastPacketTimestamp;

    for (const rule of this.rules) {
      if (rule.enabled && rule.ruleType === 'delay_exceeds' && rule.delayMs) {
        if (idleMs >= rule.delayMs) {
          // Trigger timeout alert (ensure we don't trigger it continuously, limit to once per delay duration)
          const alertId = `idle-${rule.id}-${Math.floor(now / rule.delayMs)}`;
          // We can construct a fired alert
          const alert: FiredAlert = {
            id: alertId,
            timestamp: now,
            ruleId: rule.id,
            ruleName: rule.name,
            packetId: 0,
            packetDescription: `No packets received for ${Math.round(idleMs / 1000)} seconds.`,
          };
          this.triggerAlert(alert, rule);
        }
      }
    }
  }

  public processPacket(packet: { id: number; timestamp_ns: number; protocol: string; raw_bytes: number[]; direction: string; decoded_json?: string | null }) {
    this.lastPacketTimestamp = Date.now();
    this.packetTimestamps.push(Date.now());
    if (this.packetTimestamps.length > 100) {
      this.packetTimestamps.shift();
    }

    const asciiString = packet.raw_bytes.map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    const hexString = packet.raw_bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const packetTextToTest = `${asciiString} ${hexString} ${packet.decoded_json || ''} ${packet.protocol} ${packet.direction}`;

    let isErrorPacket = false;
    if (packet.decoded_json?.includes('"severity":"error"') || packet.decoded_json?.includes('NACK') || packet.decoded_json?.includes('CRC failure')) {
      isErrorPacket = true;
      this.errorPacketsCount++;
    }

    const totalInWindow = this.packetTimestamps.length;
    const errorRate = totalInWindow > 0 ? (this.errorPacketsCount / totalInWindow) * 100 : 0;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      let triggered = false;
      let description = '';

      switch (rule.ruleType) {
        case 'pattern':
          if (rule.pattern) {
            try {
              const regex = new RegExp(rule.pattern, 'i');
              const target = rule.patternFormat === 'hex' ? hexString : packetTextToTest;
              if (regex.test(target)) {
                triggered = true;
                description = `Packet matches pattern: "${rule.pattern}"`;
              }
            } catch (e) {
              console.error('Invalid regex in alert rule:', rule.pattern, e);
            }
          }
          break;

        case 'length_equals':
          if (rule.lengthValue !== undefined && packet.raw_bytes.length === rule.lengthValue) {
            triggered = true;
            description = `Packet length equals ${rule.lengthValue} bytes`;
          }
          break;

        case 'length_exceeds':
          if (rule.lengthValue !== undefined && packet.raw_bytes.length >= rule.lengthValue) {
            triggered = true;
            description = `Packet length ${packet.raw_bytes.length} bytes exceeds threshold of ${rule.lengthValue} bytes`;
          }
          break;

        case 'byte_offset':
          if (rule.byteOffset !== undefined && rule.byteValue !== undefined && rule.byteOffset < packet.raw_bytes.length) {
            if (packet.raw_bytes[rule.byteOffset] === rule.byteValue) {
              triggered = true;
              description = `Byte at offset ${rule.byteOffset} equals 0x${rule.byteValue.toString(16).toUpperCase()}`;
            }
          }
          break;

        case 'error_rate':
          if (rule.errorRatePercentage !== undefined && errorRate >= rule.errorRatePercentage) {
            triggered = true;
            description = `Error rate (${errorRate.toFixed(1)}%) exceeds threshold of ${rule.errorRatePercentage}%`;
          }
          break;

        default:
          break;
      }

      if (triggered) {
        const firedAlert: FiredAlert = {
          id: `${packet.id}-${rule.id}-${Date.now()}`,
          timestamp: Date.now(),
          ruleId: rule.id,
          ruleName: rule.name,
          packetId: packet.id,
          packetDescription: description,
        };
        this.triggerAlert(firedAlert, rule);
      }
    }
  }

  private triggerAlert(alert: FiredAlert, rule: AlertRule) {
    // 1. Play audio beep if configured
    if (rule.actionBeep) {
      this.playBeep();
    }

    // 2. Desktop notification using Tauri if enabled
    if (rule.actionNotification) {
      this.showDesktopNotification(rule.name, alert.packetDescription);
    }

    // 3. Notify callback (which will highlight packet row or add to separate panel)
    this.onAlertTriggered(alert, rule);
  }

  private playBeep() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 note
      
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {
      console.warn('Audio Context beep failed:', e);
    }
  }

  private async showDesktopNotification(title: string, body: string) {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
      let hasPermission = await isPermissionGranted();
      if (!hasPermission) {
        const permission = await requestPermission();
        hasPermission = permission === 'granted';
      }
      if (hasPermission) {
        sendNotification({ title, body });
      }
    } catch (e) {
      // Fallback to browser Notification API
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification(title, { body });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then((permission) => {
            if (permission === 'granted') {
              new Notification(title, { body });
            }
          });
        }
      }
    }
  }
}
