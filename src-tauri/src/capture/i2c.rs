use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::io::Read;
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Emitter};
use crate::db::{Db, Packet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct I2cPacket {
    pub timestamp_ns: i64,
    pub address: u8,
    pub direction: String, // "Read" or "Write"
    pub data_bytes: Vec<u8>,
    pub ack_flags: Vec<bool>,
    pub error: Option<String>,
}

pub struct I2cCaptureSession {
    pub capture_id: i64,
    pub stop_signal: Arc<AtomicBool>,
}

impl I2cCaptureSession {
    pub fn start(
        app_handle: AppHandle,
        db: Arc<Db>,
        port_name: String,
        sda_channel: u8,
        scl_channel: u8,
    ) -> Result<Self, String> {
        let is_mock = port_name == "Mock I2C Analyzer";
        
        let mut serial_port = if !is_mock {
            let port_builder = serialport::new(&port_name, 115200)
                .timeout(std::time::Duration::from_millis(100));
            Some(port_builder.open().map_err(|e| e.to_string())?)
        } else {
            None
        };
        
        let capture = db.create_capture("I2C".to_string()).map_err(|e| e.to_string())?;
        let capture_id = capture.id;
        
        let stop_signal = Arc::new(AtomicBool::new(true));
        let stop_signal_clone = stop_signal.clone();
        
        std::thread::spawn(move || {
            let mut last_sda = 1u8;
            let mut last_scl = 1u8;
            let mut in_transaction = false;
            let mut scl_low_count = 0u32;
            let mut bit_count = 0u8;
            let mut current_byte = 0u8;
            let mut address = 0u8;
            let mut direction = "Write".to_string();
            let mut data_bytes = Vec::new();
            let mut ack_flags = Vec::new();
            let mut is_address_byte = true;
            let mut error = None;
            let mut transaction_start_ns = 0i64;
            let mut packet_id_counter = 0;
            
            let mut mock_timer = 0;
            
            // Helper to save a completed packet
            let save_and_emit = |
                pkt_id: &mut i64,
                t_start: i64,
                addr: u8,
                dir: &str,
                bytes: &[u8],
                acks: &[bool],
                err: &Option<String>,
            | {
                let i2c_pkt = I2cPacket {
                    timestamp_ns: t_start,
                    address: addr,
                    direction: dir.to_string(),
                    data_bytes: bytes.to_vec(),
                    ack_flags: acks.to_vec(),
                    error: err.clone(),
                };
                let decoded_json = serde_json::to_string(&i2c_pkt).ok();
                
                *pkt_id += 1;
                let packet = Packet {
                    id: *pkt_id,
                    timestamp_ns: t_start,
                    protocol: "I2C".to_string(),
                    raw_bytes: bytes.to_vec(),
                    direction: dir.to_string(),
                    decoded_json,
                };
                let _ = db.save_packet(capture_id, &packet);
                let _ = app_handle.emit("packet-received", packet);
            };
            
            while stop_signal_clone.load(Ordering::SeqCst) {
                let mut buf = [0u8; 256];
                let bytes_read = if is_mock {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    mock_timer += 1;
                    
                    if mock_timer % 150 == 0 {
                        // Let's generate a full I2C transaction
                        // Write to EEPROM at address 0x50, data [0x00, 0xDE, 0xAD]
                        let mut mock_samples = Vec::new();
                        
                        // SCL=1, SDA=1
                        for _ in 0..10 {
                            mock_samples.push((1 << scl_channel) | (1 << sda_channel));
                        }
                        
                        // START: SDA goes 0 while SCL=1
                        for _ in 0..5 {
                            mock_samples.push((1 << scl_channel) | (0 << sda_channel));
                        }
                        
                        let bytes_to_send = vec![0x50 << 1, 0x00, 0xDE, 0xAD];
                        for byte_to_send in bytes_to_send {
                            for bit in 0..8 {
                                let val = (byte_to_send >> (7 - bit)) & 1;
                                // SCL 0, SDA val
                                for _ in 0..2 {
                                    mock_samples.push((0 << scl_channel) | (val << sda_channel));
                                }
                                // SCL 1, SDA val (sample)
                                for _ in 0..4 {
                                    mock_samples.push((1 << scl_channel) | (val << sda_channel));
                                }
                                // SCL 0, SDA val
                                for _ in 0..2 {
                                    mock_samples.push((0 << scl_channel) | (val << sda_channel));
                                }
                            }
                            
                            // 9th bit: ACK (SDA=0)
                            // SCL 0, SDA 0
                            for _ in 0..2 {
                                mock_samples.push((0 << scl_channel) | (0 << sda_channel));
                            }
                            // SCL 1, SDA 0 (sample ACK)
                            for _ in 0..4 {
                                mock_samples.push((1 << scl_channel) | (0 << sda_channel));
                            }
                            // SCL 0, SDA 0
                            for _ in 0..2 {
                                mock_samples.push((0 << scl_channel) | (0 << sda_channel));
                            }
                        }
                        
                        // STOP: SDA goes 1 while SCL=1
                        for _ in 0..2 {
                            mock_samples.push((1 << scl_channel) | (0 << sda_channel));
                        }
                        for _ in 0..10 {
                            mock_samples.push((1 << scl_channel) | (1 << sda_channel));
                        }
                        
                        let copy_len = mock_samples.len().min(buf.len());
                        buf[..copy_len].copy_from_slice(&mock_samples[..copy_len]);
                        copy_len
                    } else {
                        0
                    }
                } else if let Some(ref mut port) = serial_port {
                    match port.read(&mut buf) {
                        Ok(n) if n > 0 => n,
                        Ok(_) => {
                            std::thread::sleep(std::time::Duration::from_millis(1));
                            0
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => 0,
                        Err(_) => break,
                    }
                } else {
                    break;
                };
                
                let timestamp_ns = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
                
                for &sample in &buf[..bytes_read] {
                    let sda = (sample >> sda_channel) & 1;
                    let scl = (sample >> scl_channel) & 1;
                    
                    // Detect START and STOP conditions
                    if scl == 1 && last_scl == 1 {
                        // SDA falling: START
                        if sda == 0 && last_sda == 1 {
                            if in_transaction {
                                save_and_emit(
                                    &mut packet_id_counter,
                                    transaction_start_ns,
                                    address,
                                    &direction,
                                    &data_bytes,
                                    &ack_flags,
                                    &error,
                                );
                            }
                            in_transaction = true;
                            is_address_byte = true;
                            bit_count = 0;
                            current_byte = 0;
                            data_bytes.clear();
                            ack_flags.clear();
                            error = None;
                            transaction_start_ns = timestamp_ns;
                        }
                        // SDA rising: STOP
                        else if sda == 1 && last_sda == 0 {
                            if in_transaction {
                                in_transaction = false;
                                save_and_emit(
                                    &mut packet_id_counter,
                                    transaction_start_ns,
                                    address,
                                    &direction,
                                    &data_bytes,
                                    &ack_flags,
                                    &error,
                                );
                            }
                        }
                    }
                    
                    // Clock stretching timeout detection
                    if scl == 0 {
                        scl_low_count += 1;
                        if scl_low_count > 5000 { // stretching timeout
                            if in_transaction && error.is_none() {
                                error = Some("Clock stretching timeout".to_string());
                                in_transaction = false;
                                save_and_emit(
                                    &mut packet_id_counter,
                                    transaction_start_ns,
                                    address,
                                    &direction,
                                    &data_bytes,
                                    &ack_flags,
                                    &error,
                                );
                            }
                        }
                    } else {
                        scl_low_count = 0;
                    }
                    
                    // Data sampling on SCL rising edge
                    if in_transaction && scl == 1 && last_scl == 0 {
                        if bit_count < 8 {
                            current_byte = (current_byte << 1) | sda;
                            bit_count += 1;
                        } else {
                            // 9th bit: ACK/NACK
                            let ack = sda == 0;
                            ack_flags.push(ack);
                            
                            if is_address_byte {
                                address = current_byte >> 1;
                                direction = if (current_byte & 1) == 1 { "Read".to_string() } else { "Write".to_string() };
                                is_address_byte = false;
                                
                                if !ack {
                                    error = Some("Address NACK (Device not found)".to_string());
                                    in_transaction = false;
                                    save_and_emit(
                                        &mut packet_id_counter,
                                        transaction_start_ns,
                                        address,
                                        &direction,
                                        &data_bytes,
                                        &ack_flags,
                                        &error,
                                    );
                                }
                            } else {
                                data_bytes.push(current_byte);
                                if !ack {
                                    error = Some("Data NACK".to_string());
                                    in_transaction = false;
                                    save_and_emit(
                                        &mut packet_id_counter,
                                        transaction_start_ns,
                                        address,
                                        &direction,
                                        &data_bytes,
                                        &ack_flags,
                                        &error,
                                    );
                                }
                            }
                            bit_count = 0;
                            current_byte = 0;
                        }
                    }
                    
                    last_sda = sda;
                    last_scl = scl;
                }
            }
        });
        
        Ok(Self {
            capture_id,
            stop_signal,
        })
    }
    
    pub fn stop(&self, db: &Db) {
        self.stop_signal.store(false, Ordering::SeqCst);
        let _ = db.end_capture(self.capture_id);
    }
}
