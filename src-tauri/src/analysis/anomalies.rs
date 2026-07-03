use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use crate::db::Packet;
use crate::analysis::baseline::ProtocolBaseline;
use crate::decoders::modbus;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anomaly {
    pub anomaly_type: String, // "Timing", "Length", "I2C NACK", "CRC failure", "Duplicate", "Garbled data"
    pub severity: String,     // "info", "warning", "error"
    pub timestamp: i64,       // ns
    pub packet_id: i64,
    pub description: String,
    pub suggested_fix: String,
}

pub struct AnomalyDetector {
    pub baseline: Option<ProtocolBaseline>,
    // For duplicate check: we store packet hash -> (timestamp_ns, packet_id)
    pub last_packets: HashMap<Vec<u8>, (i64, i64)>,
}

impl AnomalyDetector {
    pub fn new() -> Self {
        Self {
            baseline: None,
            last_packets: HashMap::new(),
        }
    }

    pub fn set_baseline(&mut self, baseline: ProtocolBaseline) {
        self.baseline = Some(baseline);
    }

    pub fn detect(&mut self, packet: &Packet, prev_timestamp_ns: Option<i64>) -> Vec<Anomaly> {
        let mut anomalies = Vec::new();
        let timestamp = packet.timestamp_ns;
        let packet_id = packet.id;
        
        // 1. Duplicate Packet Check (same packet payload within 100ms)
        let payload = &packet.raw_bytes;
        if !payload.is_empty() {
            if let Some(&(last_ts, last_id)) = self.last_packets.get(payload) {
                let diff_ms = (timestamp - last_ts) as f64 / 1_000_000.0;
                if diff_ms <= 100.0 && last_id != packet_id {
                    anomalies.push(Anomaly {
                        anomaly_type: "Duplicate".to_string(),
                        severity: "warning".to_string(),
                        timestamp,
                        packet_id,
                        description: format!("Possible duplicate transmission within {:.1}ms (prev packet #{})", diff_ms, last_id),
                        suggested_fix: "Check for retry loops, software logic errors, or physical echoes.".to_string(),
                    });
                }
            }
            self.last_packets.insert(payload.clone(), (timestamp, packet_id));
        }

        // 2. Protocol Specific Anomalies
        match packet.protocol.as_str() {
            "UART" => {
                // Garbled data check (high ratio of non-printable bytes on mostly ASCII UART)
                if !payload.is_empty() {
                    let non_printable = payload.iter().filter(|&&b| {
                        !((b >= 32 && b <= 126) || b == b'\r' || b == b'\n' || b == b'\t')
                    }).count();
                    let ratio = non_printable as f64 / payload.len() as f64;
                    if ratio > 0.3 && payload.len() >= 4 {
                        anomalies.push(Anomaly {
                            anomaly_type: "Garbled data".to_string(),
                            severity: "error".to_string(),
                            timestamp,
                            packet_id,
                            description: format!("Possible baud rate mismatch or signal integrity issue. {:.1}% non-printable bytes", ratio * 100.0),
                            suggested_fix: "Verify baud rate configurations on both sides, check ground connections and line termination.".to_string(),
                        });
                    }
                }

                // Check against baseline if ready
                if let Some(ref bl) = self.baseline {
                    // Timing anomaly check (mean + 3 * std_dev)
                    if let Some(prev) = prev_timestamp_ns {
                        let diff_ms = (timestamp - prev) as f64 / 1_000_000.0;
                        if let Some(ref inter_stat) = bl.uart_inter_arrival_ms {
                            let threshold = inter_stat.mean + (3.0 * inter_stat.std_dev).max(10.0);
                            if diff_ms > threshold && inter_stat.std_dev > 0.0 {
                                anomalies.push(Anomaly {
                                    anomaly_type: "Timing".to_string(),
                                    severity: "warning".to_string(),
                                    timestamp,
                                    packet_id,
                                    description: format!("Unexpected delay detected (expected {:.1}ms, got {:.1}ms)", inter_stat.mean, diff_ms),
                                    suggested_fix: "Investigate processor stall, thread blockages, or slave node response delays.".to_string(),
                                });
                            }
                        }
                    }

                    // Length anomaly check
                    if let Some(ref len_stat) = bl.uart_packet_length {
                        let pkt_len = payload.len() as f64;
                        let threshold_low = len_stat.mean - (3.0 * len_stat.std_dev).max(2.0);
                        let threshold_high = len_stat.mean + (3.0 * len_stat.std_dev).max(2.0);
                        if pkt_len < threshold_low || pkt_len > threshold_high {
                            anomalies.push(Anomaly {
                                anomaly_type: "Length".to_string(),
                                severity: "warning".to_string(),
                                timestamp,
                                packet_id,
                                description: format!("Truncated or oversized packet detected (length {} vs typical {:.1})", pkt_len, len_stat.mean),
                                suggested_fix: "Check frame framing logic, buffer overflows, or premature transmissions.".to_string(),
                            });
                        }
                    }
                }

                // Modbus CRC Failure check (if payload looks like Modbus)
                if payload.len() >= 4 {
                    if let Some(frame) = modbus::decode_modbus(payload) {
                        if !frame.valid_crc {
                            anomalies.push(Anomaly {
                                anomaly_type: "CRC failure".to_string(),
                                severity: "error".to_string(),
                                timestamp,
                                packet_id,
                                description: format!("Modbus CRC error on device {}", frame.device_addr),
                                suggested_fix: "Verify RS-485 line termination, check for noise or baud rate deviation.".to_string(),
                            });
                        }
                    }
                }
            }
            "I2C" => {
                if let Some(json_str) = &packet.decoded_json {
                    if let Ok(i2c_pkt) = serde_json::from_str::<serde_json::Value>(json_str) {
                        let address = i2c_pkt["address"].as_u64().unwrap_or(0) as u8;
                        let acks = i2c_pkt["ack_flags"].as_array()
                            .map(|a| a.iter().map(|v| v.as_bool().unwrap_or(false)).collect::<Vec<bool>>())
                            .unwrap_or_default();
                        
                        // Check for I2C Address NACK (First ACK/NACK bit in standard transactions represents the address ACK)
                        if !acks.is_empty() && !acks[0] {
                            anomalies.push(Anomaly {
                                anomaly_type: "I2C NACK".to_string(),
                                severity: "error".to_string(),
                                timestamp,
                                packet_id,
                                description: format!("Device 0x{:02X} not responding (NACK on address)", address),
                                suggested_fix: "Check hardware connections, pull-up resistors, or verify device power state and I2C address.".to_string(),
                            });
                        }

                        // Check I2C NACK on data bytes (excluding address ACK/NACK at index 0)
                        if acks.len() > 1 {
                            for (idx, &ack) in acks.iter().enumerate().skip(1) {
                                if !ack {
                                    anomalies.push(Anomaly {
                                        anomaly_type: "I2C NACK".to_string(),
                                        severity: "warning".to_string(),
                                        timestamp,
                                        packet_id,
                                        description: format!("Device 0x{:02X} NACK on data byte {}", address, idx - 1),
                                        suggested_fix: "Verify if the slave is busy, buffer is full, or writing to a read-only address.".to_string(),
                                    });
                                    break;
                                }
                            }
                        }

                        // Compare against baseline
                        if let Some(ref bl) = self.baseline {
                            if let Some(ref expected_acks) = bl.i2c_expected_ack.get(&address) {
                                // If the ACK pattern length or shape mismatches considerably
                                if acks.len() != expected_acks.len() {
                                    anomalies.push(Anomaly {
                                        anomaly_type: "Length".to_string(),
                                        severity: "warning".to_string(),
                                        timestamp,
                                        packet_id,
                                        description: format!("I2C transaction length mismatch for device 0x{:02X} (got {}, expected {})", address, acks.len(), expected_acks.len()),
                                        suggested_fix: "Verify if slave returned less/more bytes or driver aborted early.".to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            "SPI" => {
                if let Some(ref bl) = self.baseline {
                    if let Some(ref len_stat) = bl.spi_frame_length {
                        let pkt_len = payload.len() as f64;
                        let threshold_low = len_stat.mean - (3.0 * len_stat.std_dev).max(2.0);
                        let threshold_high = len_stat.mean + (3.0 * len_stat.std_dev).max(2.0);
                        if pkt_len < threshold_low || pkt_len > threshold_high {
                            anomalies.push(Anomaly {
                                anomaly_type: "Length".to_string(),
                                severity: "warning".to_string(),
                                timestamp,
                                packet_id,
                                description: format!("Truncated SPI frame detected (length {} vs typical {:.1})", pkt_len, len_stat.mean),
                                suggested_fix: "Check master clock configuration or chip select timing control.".to_string(),
                            });
                        }
                    }
                }
            }
            _ => {}
        }
        
        anomalies
    }
}
