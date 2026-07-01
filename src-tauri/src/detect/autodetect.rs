use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DetectedProtocol {
    pub protocol: String,
    pub confidence: f32,
}

// Modbus CRC-16 calculation
fn calculate_modbus_crc(data: &[u8]) -> u16 {
    let mut crc = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            if (crc & 1) != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

pub fn detect_protocol(bytes: &[u8]) -> Vec<DetectedProtocol> {
    if bytes.is_empty() {
        return vec![
            DetectedProtocol { protocol: "Raw binary".to_string(), confidence: 0.0 },
            DetectedProtocol { protocol: "AT Commands".to_string(), confidence: 0.0 },
            DetectedProtocol { protocol: "NMEA GPS".to_string(), confidence: 0.0 },
            DetectedProtocol { protocol: "Modbus RTU".to_string(), confidence: 0.0 },
            DetectedProtocol { protocol: "MIDI".to_string(), confidence: 0.0 },
        ];
    }

    let len = bytes.len();
    
    // 1. Calculate printability
    let mut printable_count = 0;
    for &b in bytes {
        if (b >= 32 && b <= 126) || b == b'\r' || b == b'\n' || b == b'\t' {
            printable_count += 1;
        }
    }
    let printable_ratio = printable_count as f32 / len as f32;

    // --- AT Commands Score ---
    let mut at_score: f32 = 0.0;
    if printable_ratio > 0.8 {
        let text = String::from_utf8_lossy(bytes).to_uppercase();
        if text.contains("AT") {
            at_score += 40.0;
        }
        if text.contains("OK") {
            at_score += 30.0;
        }
        if text.contains("ERROR") {
            at_score += 20.0;
        }
        if text.contains("\r\n") {
            at_score += 10.0;
        }
    }
    let at_confidence = at_score.min(100.0);

    // --- NMEA GPS Score ---
    let mut nmea_score: f32 = 0.0;
    if printable_ratio > 0.8 {
        let text = String::from_utf8_lossy(bytes);
        let sentences_start = text.matches('$').count();
        let gp_gn_matches = text.matches("$GP").count() + text.matches("$GN").count();
        let commas = text.matches(',').count();
        
        if sentences_start > 0 {
            nmea_score += 30.0;
        }
        if gp_gn_matches > 0 {
            nmea_score += 40.0;
        }
        if commas > 3 {
            nmea_score += 30.0;
        }
    }
    let nmea_confidence = nmea_score.min(100.0);

    // --- Modbus RTU Score ---
    let mut modbus_score = 0.0;
    // Look for valid function code and valid CRC
    // Since Modbus packets are typically 4 to 256 bytes
    let mut found_valid_crc = false;
    if len >= 4 {
        for i in 0..=(len - 4) {
            let func_code = bytes[i + 1];
            if [1, 2, 3, 4, 5, 6, 15, 16].contains(&func_code) {
                // Try different packet lengths from this start offset
                for packet_len in 4..=256 {
                    if i + packet_len > len {
                        break;
                    }
                    let sub = &bytes[i..(i + packet_len)];
                    let calculated = calculate_modbus_crc(&sub[..packet_len - 2]);
                    let received = ((sub[packet_len - 1] as u16) << 8) | (sub[packet_len - 2] as u16);
                    if calculated == received {
                        found_valid_crc = true;
                        break;
                    }
                }
            }
            if found_valid_crc {
                break;
            }
        }
    }
    if found_valid_crc {
        modbus_score += 85.0;
    } else {
        // Fallback score based on function codes
        let mut potential_matches = 0;
        for i in 0..(len - 1) {
            if [1, 2, 3, 4, 5, 6, 15, 16].contains(&bytes[i]) {
                potential_matches += 1;
            }
        }
        modbus_score += (potential_matches as f32 / len as f32) * 50.0;
    }
    let modbus_confidence = modbus_score.min(100.0);

    // --- MIDI Score ---
    let mut midi_score = 0.0;
    let mut i = 0;
    let mut valid_midi_bytes = 0;
    while i < len {
        let b = bytes[i];
        if b >= 0x80 {
            // Status byte
            let cmd = b & 0xF0;
            let bytes_needed = match cmd {
                0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => 2,
                0xC0 | 0xD0 => 1,
                _ => 0, // system common or ignored
            };
            
            let mut all_data_valid = true;
            if bytes_needed > 0 && i + bytes_needed < len {
                for offset in 1..=bytes_needed {
                    if bytes[i + offset] >= 0x80 {
                        all_data_valid = false;
                        break;
                    }
                }
            } else if bytes_needed > 0 {
                all_data_valid = false;
            }
            
            if all_data_valid {
                valid_midi_bytes += 1 + bytes_needed;
                i += 1 + bytes_needed;
                continue;
            }
        }
        i += 1;
    }
    let midi_ratio = valid_midi_bytes as f32 / len as f32;
    if midi_ratio > 0.3 {
        midi_score += midi_ratio * 100.0;
    }
    let midi_confidence = midi_score.min(100.0);

    // --- Raw Binary Score ---
    let binary_confidence = ((1.0 - printable_ratio) * 100.0).min(100.0);

    let mut results = vec![
        DetectedProtocol { protocol: "AT Commands".to_string(), confidence: at_confidence },
        DetectedProtocol { protocol: "NMEA GPS".to_string(), confidence: nmea_confidence },
        DetectedProtocol { protocol: "Modbus RTU".to_string(), confidence: modbus_confidence },
        DetectedProtocol { protocol: "MIDI".to_string(), confidence: midi_confidence },
        DetectedProtocol { protocol: "Raw binary".to_string(), confidence: binary_confidence },
    ];

    results.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    results
}
