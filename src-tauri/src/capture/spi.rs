use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::io::Read;
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Emitter};
use crate::db::{Db, Packet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpiPacket {
    pub timestamp_ns: i64,
    pub cs_channel: u8,
    pub mosi_bytes: Vec<u8>,
    pub miso_bytes: Vec<u8>,
    pub mode: u8,
}

pub struct SpiCaptureSession {
    pub capture_id: i64,
    pub stop_signal: Arc<AtomicBool>,
}

impl SpiCaptureSession {
    pub fn start(
        app_handle: AppHandle,
        db: Arc<Db>,
        port_name: String,
        mosi_channel: u8,
        miso_channel: u8,
        clk_channel: u8,
        cs_channel: u8,
        mode: u8,
        bit_order: String,
    ) -> Result<Self, String> {
        let is_mock = port_name == "Mock SPI Analyzer";
        
        let mut serial_port = if !is_mock {
            let port_builder = serialport::new(&port_name, 115200)
                .timeout(std::time::Duration::from_millis(100));
            Some(port_builder.open().map_err(|e| e.to_string())?)
        } else {
            None
        };
        
        let capture = db.create_capture("SPI".to_string()).map_err(|e| e.to_string())?;
        let capture_id = capture.id;
        
        let stop_signal = Arc::new(AtomicBool::new(true));
        let stop_signal_clone = stop_signal.clone();
        
        let sample_on_rising = mode == 0 || mode == 3;
        let lsb_first = bit_order.to_uppercase() == "LSB";
        
        std::thread::spawn(move || {
            let mut last_cs = 1u8;
            let mut last_clk = if mode >= 2 { 1u8 } else { 0u8 };
            let mut in_frame = false;
            let mut mosi_bits = 0u32;
            let mut miso_bits = 0u32;
            let mut bit_count = 0u8;
            let mut mosi_bytes = Vec::new();
            let mut miso_bytes = Vec::new();
            let mut frame_start_ns = 0i64;
            let mut packet_id_counter = 0;
            
            let mut mock_timer = 0;
            
            while stop_signal_clone.load(Ordering::SeqCst) {
                let mut buf = [0u8; 256];
                let bytes_read = if is_mock {
                    // Generate mock SPI logic levels
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    mock_timer += 1;
                    
                    if mock_timer % 100 == 0 {
                        // Let's generate a full SPI frame of "HELLO" -> "WORLD"
                        let mosi_str = b"HELLO SPI DATA SENT";
                        let miso_str = b"WORLD SPI RESPONSE ";
                        let mut mock_samples = Vec::new();
                        
                        let cpol = if mode >= 2 { 1u8 } else { 0u8 };
                        
                        // CS High (Idle state)
                        for _ in 0..10 {
                            let mut sample = 0u8;
                            sample |= 1 << cs_channel; // CS High
                            sample |= cpol << clk_channel;
                            mock_samples.push(sample);
                        }
                        
                        // CS Low (Start)
                        for _ in 0..5 {
                            let mut sample = 0u8;
                            sample |= 0 << cs_channel; // CS Low
                            sample |= cpol << clk_channel;
                            mock_samples.push(sample);
                        }
                        
                        // Transmit bytes
                        for idx in 0..mosi_str.len() {
                            let tx_byte = mosi_str[idx];
                            let rx_byte = miso_str[idx % miso_str.len()];
                            
                            for bit in 0..8 {
                                let shift = if lsb_first { bit } else { 7 - bit };
                                let tx_bit = (tx_byte >> shift) & 1;
                                let rx_bit = (rx_byte >> shift) & 1;
                                
                                // Phase 1: Clock Idle, Data set
                                let mut sample1 = 0u8;
                                sample1 |= 0 << cs_channel;
                                sample1 |= cpol << clk_channel;
                                sample1 |= tx_bit << mosi_channel;
                                sample1 |= rx_bit << miso_channel;
                                mock_samples.push(sample1);
                                mock_samples.push(sample1);
                                
                                // Phase 2: Clock Toggle
                                let mut sample2 = sample1;
                                sample2 ^= 1 << clk_channel; // Toggle SCL
                                mock_samples.push(sample2);
                                mock_samples.push(sample2);
                                
                                // Phase 3: Clock back to Idle
                                mock_samples.push(sample1);
                            }
                        }
                        
                        // CS High (End)
                        for _ in 0..10 {
                            let mut sample = 0u8;
                            sample |= 1 << cs_channel;
                            sample |= cpol << clk_channel;
                            mock_samples.push(sample);
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
                    let cs = (sample >> cs_channel) & 1;
                    let clk = (sample >> clk_channel) & 1;
                    let mosi = (sample >> mosi_channel) & 1;
                    let miso = (sample >> miso_channel) & 1;
                    
                    // CS falling edge: Start frame
                    if cs == 0 && last_cs == 1 {
                        in_frame = true;
                        mosi_bytes.clear();
                        miso_bytes.clear();
                        bit_count = 0;
                        mosi_bits = 0;
                        miso_bits = 0;
                        frame_start_ns = timestamp_ns;
                    }
                    
                    if in_frame {
                        // Check clock transition
                        let is_clk_edge = if sample_on_rising {
                            clk == 1 && last_clk == 0
                        } else {
                            clk == 0 && last_clk == 1
                        };
                        
                        if is_clk_edge {
                            if lsb_first {
                                mosi_bits |= (mosi as u32) << bit_count;
                                miso_bits |= (miso as u32) << bit_count;
                            } else {
                                mosi_bits = (mosi_bits << 1) | (mosi as u32);
                                miso_bits = (miso_bits << 1) | (miso as u32);
                            }
                            bit_count += 1;
                            
                            if bit_count == 8 {
                                mosi_bytes.push(mosi_bits as u8);
                                miso_bytes.push(miso_bits as u8);
                                bit_count = 0;
                                mosi_bits = 0;
                                miso_bits = 0;
                            }
                        }
                    }
                    
                    // CS rising edge: End frame
                    if cs == 1 && last_cs == 0 {
                        if in_frame {
                            in_frame = false;
                            
                            // Save whatever we got
                            if !mosi_bytes.is_empty() || !miso_bytes.is_empty() {
                                let spi_pkt = SpiPacket {
                                    timestamp_ns: frame_start_ns,
                                    cs_channel,
                                    mosi_bytes: mosi_bytes.clone(),
                                    miso_bytes: miso_bytes.clone(),
                                    mode,
                                };
                                let decoded_json = serde_json::to_string(&spi_pkt).ok();
                                
                                // 1. MOSI Packet
                                if !mosi_bytes.is_empty() {
                                    packet_id_counter += 1;
                                    let mosi_packet = Packet {
                                        id: packet_id_counter,
                                        timestamp_ns: frame_start_ns,
                                        protocol: "SPI".to_string(),
                                        raw_bytes: mosi_bytes.clone(),
                                        direction: "MOSI".to_string(),
                                        decoded_json: decoded_json.clone(),
                                    };
                                    let _ = db.save_packet(capture_id, &mosi_packet);
                                    let _ = app_handle.emit("packet-received", mosi_packet);
                                }
                                
                                // 2. MISO Packet
                                if !miso_bytes.is_empty() {
                                    packet_id_counter += 1;
                                    let miso_packet = Packet {
                                        id: packet_id_counter,
                                        timestamp_ns: frame_start_ns + 1, // slight offset to order in list
                                        protocol: "SPI".to_string(),
                                        raw_bytes: miso_bytes.clone(),
                                        direction: "MISO".to_string(),
                                        decoded_json: decoded_json.clone(),
                                    };
                                    let _ = db.save_packet(capture_id, &miso_packet);
                                    let _ = app_handle.emit("packet-received", miso_packet);
                                }
                            }
                        }
                    }
                    
                    last_cs = cs;
                    last_clk = clk;
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
