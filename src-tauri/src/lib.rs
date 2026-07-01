mod db;
mod capture;
mod detect;
pub mod decoders;


use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use db::{Db, Packet, Capture};
use capture::uart::SerialPortInfo;
use serde::{Serialize, Deserialize};


pub enum ActiveSession {
    Uart(capture::uart::CaptureSession),
    Spi(capture::spi::SpiCaptureSession),
    I2c(capture::i2c::I2cCaptureSession),
}

impl ActiveSession {
    pub fn stop(&self, db: &Db) {
        match self {
            ActiveSession::Uart(s) => s.stop(db),
            ActiveSession::Spi(s) => s.stop(db),
            ActiveSession::I2c(s) => s.stop(db),
        }
    }
}

pub struct AppState {
    pub db: Arc<Db>,
    pub session: Mutex<Option<ActiveSession>>,
}

#[tauri::command]
fn list_ports() -> Vec<SerialPortInfo> {
    capture::uart::list_serial_ports()
}

#[tauri::command]
async fn start_capture(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    port: String,
    baud: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
) -> Result<i64, String> {
    // First, stop any active capture
    {
        let mut session_guard = state.session.lock().unwrap();
        if let Some(session) = session_guard.take() {
            session.stop(&state.db);
        }
    }

    // Start a new session
    let session = capture::uart::CaptureSession::start(
        app_handle,
        state.db.clone(),
        port,
        baud,
        data_bits,
        parity,
        stop_bits,
    )?;
    
    let capture_id = session.capture_id;
    
    let mut session_guard = state.session.lock().unwrap();
    *session_guard = Some(ActiveSession::Uart(session));
    
    Ok(capture_id)
}

#[tauri::command]
async fn start_spi_capture(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    port: String,
    mosi_channel: u8,
    miso_channel: u8,
    clk_channel: u8,
    cs_channel: u8,
    mode: u8,
    bit_order: String,
) -> Result<i64, String> {
    // First, stop any active capture
    {
        let mut session_guard = state.session.lock().unwrap();
        if let Some(session) = session_guard.take() {
            session.stop(&state.db);
        }
    }

    // Start a new session
    let session = capture::spi::SpiCaptureSession::start(
        app_handle,
        state.db.clone(),
        port,
        mosi_channel,
        miso_channel,
        clk_channel,
        cs_channel,
        mode,
        bit_order,
    )?;
    
    let capture_id = session.capture_id;
    
    let mut session_guard = state.session.lock().unwrap();
    *session_guard = Some(ActiveSession::Spi(session));
    
    Ok(capture_id)
}

#[tauri::command]
async fn start_i2c_capture(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    port: String,
    sda_channel: u8,
    scl_channel: u8,
) -> Result<i64, String> {
    // First, stop any active capture
    {
        let mut session_guard = state.session.lock().unwrap();
        if let Some(session) = session_guard.take() {
            session.stop(&state.db);
        }
    }

    // Start a new session
    let session = capture::i2c::I2cCaptureSession::start(
        app_handle,
        state.db.clone(),
        port,
        sda_channel,
        scl_channel,
    )?;
    
    let capture_id = session.capture_id;
    
    let mut session_guard = state.session.lock().unwrap();
    *session_guard = Some(ActiveSession::I2c(session));
    
    Ok(capture_id)
}

#[tauri::command]
async fn stop_capture(state: State<'_, AppState>) -> Result<(), String> {
    let mut session_guard = state.session.lock().unwrap();
    if let Some(session) = session_guard.take() {
        session.stop(&state.db);
    }
    Ok(())
}

#[tauri::command]
async fn get_captured_packets(
    state: State<'_, AppState>,
    capture_id: i64,
    offset: i64,
    limit: i64,
) -> Result<Vec<Packet>, String> {
    state.db.get_packets(capture_id, offset, limit).map_err(|e| e.to_string())
}

#[tauri::command]
async fn detect_uart_protocol(
    state: State<'_, AppState>,
    capture_id: i64,
) -> Result<Vec<detect::autodetect::DetectedProtocol>, String> {
    let packets = state.db.get_packets(capture_id, 0, 500).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    for p in packets {
        bytes.extend_from_slice(&p.raw_bytes);
        if bytes.len() >= 256 {
            break;
        }
    }
    if bytes.len() > 256 {
        bytes.truncate(256);
    }
    Ok(detect::autodetect::detect_protocol(&bytes))
}

#[tauri::command]
async fn get_captures(state: State<'_, AppState>) -> Result<Vec<Capture>, String> {
    let conn = state.db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, name, protocol, started_at, ended_at, packet_count FROM captures ORDER BY id DESC").map_err(|e| e.to_string())?;
    let capture_iter = stmt.query_map([], |row| {
        Ok(Capture {
            id: row.get(0)?,
            name: row.get(1)?,
            protocol: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            packet_count: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    
    let mut captures = Vec::new();
    for capture in capture_iter {
        captures.push(capture.map_err(|e| e.to_string())?);
    }
    Ok(captures)
}

#[derive(Serialize, Deserialize)]
pub enum DecodedPayload {
    Nmea(decoders::nmea::NmeaFrame),
    Modbus(decoders::modbus::ModbusFrame),
    At(decoders::at_commands::AtCommandFrame),
    Raw(String),
}

#[tauri::command]
fn decode_packet(bytes: Vec<u8>, decoder: String) -> Result<DecodedPayload, String> {
    match decoder.as_str() {
        "NMEA" => {
            if let Some(frame) = decoders::nmea::decode_nmea(&bytes) {
                Ok(DecodedPayload::Nmea(frame))
            } else {
                Err("Failed to parse as NMEA".to_string())
            }
        }
        "Modbus RTU" => {
            if let Some(frame) = decoders::modbus::decode_modbus(&bytes) {
                Ok(DecodedPayload::Modbus(frame))
            } else {
                Err("Failed to parse as Modbus RTU".to_string())
            }
        }
        "AT Commands" => {
            if let Some(frame) = decoders::at_commands::decode_at(&bytes) {
                Ok(DecodedPayload::At(frame))
            } else {
                Err("Failed to parse as AT Command".to_string())
            }
        }
        _ => {
            let hex_str = hex::encode(&bytes);
            Ok(DecodedPayload::Raw(hex_str))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&app_data_dir).unwrap();
            let db_path = app_data_dir.join("probetrace.db");
            let db = Arc::new(Db::new(&db_path));
            
            app.manage(AppState {
                db,
                session: Mutex::new(None),
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            start_capture,
            start_spi_capture,
            start_i2c_capture,
            stop_capture,
            get_captured_packets,
            get_captures,
            detect_uart_protocol,
            decode_packet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
