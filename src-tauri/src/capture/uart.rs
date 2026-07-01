use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::io::Read;
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Emitter};
use crate::db::{Db, Packet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialPortInfo {
    pub name: String,
    pub manufacturer: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

pub fn list_serial_ports() -> Vec<SerialPortInfo> {
    let mut result = Vec::new();
    
    // Add mock simulator devices
    result.push(SerialPortInfo {
        name: "Mock UART Port".to_string(),
        manufacturer: Some("Simulator".to_string()),
        vid: Some(0x0001),
        pid: Some(0x0001),
    });
    result.push(SerialPortInfo {
        name: "Mock SPI Analyzer".to_string(),
        manufacturer: Some("Simulator".to_string()),
        vid: Some(0x0002),
        pid: Some(0x0002),
    });
    result.push(SerialPortInfo {
        name: "Mock I2C Analyzer".to_string(),
        manufacturer: Some("Simulator".to_string()),
        vid: Some(0x0003),
        pid: Some(0x0003),
    });

    if let Ok(ports) = serialport::available_ports() {
        for port in ports {
            let mut manufacturer = None;
            let mut vid = None;
            let mut pid = None;
            
            if let serialport::SerialPortType::UsbPort(usb_info) = port.port_type {
                manufacturer = usb_info.manufacturer;
                vid = Some(usb_info.vid);
                pid = Some(usb_info.pid);
            }
            
            result.push(SerialPortInfo {
                name: port.port_name,
                manufacturer,
                vid,
                pid,
            });
        }
    }
    result
}

pub struct CaptureSession {
    pub capture_id: i64,
    pub stop_signal: Arc<AtomicBool>,
    pub packets: Arc<tokio::sync::RwLock<Vec<Packet>>>,
}

impl CaptureSession {
    pub fn start(
        app_handle: AppHandle,
        db: Arc<Db>,
        port_name: String,
        baud: u32,
        data_bits: u8,
        parity: String,
        stop_bits: u8,
    ) -> Result<Self, String> {
        let is_mock = port_name == "Mock UART Port";
        let mut serial_port = if !is_mock {
            let port_builder = serialport::new(&port_name, baud)
                .data_bits(match data_bits {
                    5 => serialport::DataBits::Five,
                    6 => serialport::DataBits::Six,
                    7 => serialport::DataBits::Seven,
                    _ => serialport::DataBits::Eight,
                })
                .parity(match parity.to_lowercase().as_str() {
                    "odd" => serialport::Parity::Odd,
                    "even" => serialport::Parity::Even,
                    _ => serialport::Parity::None,
                })
                .stop_bits(match stop_bits {
                    2 => serialport::StopBits::Two,
                    _ => serialport::StopBits::One,
                })
                .timeout(std::time::Duration::from_millis(100));
            Some(port_builder.open().map_err(|e| e.to_string())?)
        } else {
            None
        };
        
        // Create capture entry in SQLite db
        let capture = db.create_capture("UART".to_string()).map_err(|e| e.to_string())?;
        let capture_id = capture.id;
        
        let stop_signal = Arc::new(AtomicBool::new(true));
        let stop_signal_clone = stop_signal.clone();
        
        let packets = Arc::new(tokio::sync::RwLock::new(Vec::new()));
        let packets_clone = packets.clone();
        
        std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            let mut packet_id_counter = 0;
            
            // NMEA GPS mock sentence sequence
            let nmea_data = b"$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A\r\n";
            let mut nmea_idx = 0;

            while stop_signal_clone.load(Ordering::SeqCst) {
                let bytes_read = if is_mock {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    // Send 8 characters from NMEA sentence
                    let mut count = 0;
                    for i in 0..8 {
                        buf[i] = nmea_data[nmea_idx];
                        nmea_idx = (nmea_idx + 1) % nmea_data.len();
                        count += 1;
                    }
                    count
                } else if let Some(ref mut port) = serial_port {
                    match port.read(&mut buf) {
                        Ok(n) => n,
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => 0,
                        Err(_) => break,
                    }
                } else {
                    break;
                };

                if bytes_read > 0 {
                    for i in 0..bytes_read {
                        let byte = buf[i];
                        let timestamp_ns = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
                        packet_id_counter += 1;
                        
                        let packet = Packet {
                            id: packet_id_counter,
                            timestamp_ns,
                            protocol: "UART".to_string(),
                            raw_bytes: vec![byte],
                            direction: "RX".to_string(),
                            decoded_json: None,
                        };
                        
                        // Save to SQLite
                        let _ = db.save_packet(capture_id, &packet);
                        
                        // Buffer in memory
                        let mut pkts = packets_clone.blocking_write();
                        pkts.push(packet.clone());
                        
                        // Emit to frontend
                        let _ = app_handle.emit("packet-received", packet);
                    }
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        });
        
        Ok(Self {
            capture_id,
            stop_signal,
            packets,
        })
    }

    pub fn stop(&self, db: &Db) {
        self.stop_signal.store(false, Ordering::SeqCst);
        let _ = db.end_capture(self.capture_id);
    }
}
