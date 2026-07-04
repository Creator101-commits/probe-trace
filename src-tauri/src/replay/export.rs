use serde::{Serialize, Deserialize};
use std::fs::File;
use std::io::{Write, Read};
use crate::db::{Packet, Capture};

#[derive(Serialize, Deserialize)]
pub struct PTraceExport {
    pub magic: String, // "PTRACE"
    pub capture: Capture,
    pub packets: Vec<Packet>,
}

#[tauri::command]
pub async fn export_ptrace(
    state: tauri::State<'_, crate::AppState>,
    capture_id: i64,
    file_path: String,
) -> Result<(), String> {
    let capture = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, protocol, started_at, ended_at, packet_count FROM captures WHERE id = ?1",
            rusqlite::params![capture_id],
            |row| Ok(Capture {
                id: row.get(0)?,
                name: row.get(1)?,
                protocol: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                packet_count: row.get(5)?,
            })
        ).map_err(|e| e.to_string())?
    };

    let packets = state.db.get_packets(capture_id, 0, 1000000).map_err(|e| e.to_string())?;

    let export = PTraceExport {
        magic: "PTRACE".to_string(),
        capture,
        packets,
    };

    let binary = serde_json::to_vec(&export).map_err(|e| e.to_string())?;
    let mut file = File::create(&file_path).map_err(|e| e.to_string())?;
    file.write_all(&binary).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn import_ptrace(
    state: tauri::State<'_, crate::AppState>,
    file_path: String,
) -> Result<i64, String> {
    let mut file = File::open(&file_path).map_err(|e| e.to_string())?;
    let mut binary = Vec::new();
    file.read_to_end(&mut binary).map_err(|e| e.to_string())?;

    let import: PTraceExport = serde_json::from_slice(&binary).map_err(|e| e.to_string())?;
    if import.magic != "PTRACE" {
        return Err("Invalid file format. Missing magic header PTRACE".to_string());
    }

    // Insert imported capture into DB
    let new_capture_id = {
        let conn = state.db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO captures (name, protocol, started_at, ended_at, packet_count) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                format!("{}_imported", import.capture.name),
                import.capture.protocol,
                import.capture.started_at,
                import.capture.ended_at,
                import.capture.packet_count
            ],
        ).map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    // Save packets using transaction batching
    state.db.save_packets_batch(new_capture_id, &import.packets).map_err(|e| e.to_string())?;

    Ok(new_capture_id)
}

#[tauri::command]
pub async fn export_csv(
    state: tauri::State<'_, crate::AppState>,
    capture_id: i64,
    file_path: String,
) -> Result<(), String> {
    let packets = state.db.get_packets(capture_id, 0, 1000000).map_err(|e| e.to_string())?;
    let mut file = File::create(&file_path).map_err(|e| e.to_string())?;

    writeln!(file, "Packet ID,Timestamp (ns),Protocol,Direction,Hex Bytes,Decoded Value").map_err(|e| e.to_string())?;
    for p in packets {
        let hex_str = hex::encode(&p.raw_bytes).to_uppercase();
        let decoded = p.decoded_json.clone().unwrap_or_else(|| "".to_string()).replace(",", ";");
        writeln!(
            file,
            "{},{},{},{},{},{}",
            p.id,
            p.timestamp_ns,
            p.protocol,
            p.direction,
            hex_str,
            decoded
        ).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn export_pcap(
    state: tauri::State<'_, crate::AppState>,
    capture_id: i64,
    file_path: String,
) -> Result<(), String> {
    let packets = state.db.get_packets(capture_id, 0, 1000000).map_err(|e| e.to_string())?;
    let mut file = File::create(&file_path).map_err(|e| e.to_string())?;

    // Write PCAP Global Header
    // Magic Number (32 bits) = 0xa1b2c3d4
    // Major Version (16 bits) = 2
    // Minor Version (16 bits) = 4
    // Timezone Offset (32 bits) = 0
    // Timestamp Accuracy (32 bits) = 0
    // Max Packet Length (32 bits) = 65535
    // Link Type (32 bits) = 147 (DLT_USER0 for custom protocol payloads)
    let mut global_hdr = Vec::new();
    global_hdr.extend_from_slice(&0xa1b2c3d4u32.to_ne_bytes());
    global_hdr.extend_from_slice(&2u16.to_ne_bytes());
    global_hdr.extend_from_slice(&4u16.to_ne_bytes());
    global_hdr.extend_from_slice(&0i32.to_ne_bytes());
    global_hdr.extend_from_slice(&0u32.to_ne_bytes());
    global_hdr.extend_from_slice(&65535u32.to_ne_bytes());
    global_hdr.extend_from_slice(&147u32.to_ne_bytes()); // DLT_USER0
    file.write_all(&global_hdr).map_err(|e| e.to_string())?;

    for p in packets {
        // Write PCAP Packet Record Header
        // Timestamp seconds (32 bits)
        // Timestamp microseconds (32 bits)
        // Saved Packet Length (32 bits)
        // Original Packet Length (32 bits)
        let sec = (p.timestamp_ns / 1_000_000_000) as u32;
        let usec = ((p.timestamp_ns % 1_000_000_000) / 1_000) as u32;
        let len = p.raw_bytes.len() as u32;

        let mut pkt_hdr = Vec::new();
        pkt_hdr.extend_from_slice(&sec.to_ne_bytes());
        pkt_hdr.extend_from_slice(&usec.to_ne_bytes());
        pkt_hdr.extend_from_slice(&len.to_ne_bytes());
        pkt_hdr.extend_from_slice(&len.to_ne_bytes());

        file.write_all(&pkt_hdr).map_err(|e| e.to_string())?;
        file.write_all(&p.raw_bytes).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn import_pcap(
    state: tauri::State<'_, crate::AppState>,
    file_path: String,
) -> Result<i64, String> {
    let mut file = File::open(&file_path).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(|e| e.to_string())?;

    if data.len() < 24 {
        return Err("PCAP file is too short to contain a global header".to_string());
    }

    // Parse magic to verify PCAP
    let magic = u32::from_ne_bytes([data[0], data[1], data[2], data[3]]);
    let swap_bytes = magic == 0xd4c3b2a1;
    if magic != 0xa1b2c3d4 && !swap_bytes {
        return Err("Invalid PCAP magic number".to_string());
    }

    let protocol = "UART".to_string(); // Fallback default
    let capture_id = {
        let conn = state.db.conn.lock().unwrap();
        let started_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO captures (name, protocol, started_at, packet_count) VALUES (?1, ?2, ?3, 0)",
            rusqlite::params![format!("pcap_import_{}", chrono::Utc::now().format("%Y%m%d_%H%M%S")), protocol, started_at],
        ).map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };

    let mut offset = 24;
    let mut packets = Vec::new();
    let mut packet_id = 0;

    while offset + 16 <= data.len() {
        let mut sec = u32::from_ne_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
        let mut usec = u32::from_ne_bytes([data[offset+4], data[offset+5], data[offset+6], data[offset+7]]);
        let mut incl_len = u32::from_ne_bytes([data[offset+8], data[offset+9], data[offset+10], data[offset+11]]);
        
        if swap_bytes {
            sec = sec.swap_bytes();
            usec = usec.swap_bytes();
            incl_len = incl_len.swap_bytes();
        }

        offset += 16;
        let len = incl_len as usize;
        if offset + len > data.len() {
            break;
        }

        let raw_bytes = data[offset..offset+len].to_vec();
        offset += len;

        let timestamp_ns = (sec as i64 * 1_000_000_000) + (usec as i64 * 1_000);
        packet_id += 1;

        packets.push(Packet {
            id: packet_id,
            timestamp_ns,
            protocol: protocol.clone(),
            raw_bytes,
            direction: "RX".to_string(),
            decoded_json: None,
        });
    }

    state.db.save_packets_batch(capture_id, &packets).map_err(|e| e.to_string())?;

    Ok(capture_id)
}

#[tauri::command]
pub async fn export_html_report(
    state: tauri::State<'_, crate::AppState>,
    capture_id: i64,
    file_path: String,
) -> Result<(), String> {
    let capture = {
        let conn = state.db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, protocol, started_at, ended_at, packet_count FROM captures WHERE id = ?1",
            rusqlite::params![capture_id],
            |row| Ok(Capture {
                id: row.get(0)?,
                name: row.get(1)?,
                protocol: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                packet_count: row.get(5)?,
            })
        ).map_err(|e| e.to_string())?
    };

    let packets = state.db.get_packets(capture_id, 0, 500).map_err(|e| e.to_string())?; // limit to 500 for html report size

    let mut html = String::new();
    html.push_str("<!DOCTYPE html><html><head><title>ProbeTrace Export Report</title>");
    html.push_str("<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;background-color:#0f172a;color:#f8fafc;padding:24px;}h1,h2{color:#6366f1;}table{width:100%;border-collapse:collapse;margin-top:16px;}th,td{border:1px solid #334155;padding:8px;text-align:left;font-family:monospace;font-size:12px;}th{background-color:#1e293b;color:#a5b4fc;}tr:nth-child(even){background-color:#1e293b/40;}.badge{padding:2px 6px;border-radius:4px;font-weight:bold;font-size:10px;}.tx{background-color:#581c87;color:#d8b4fe;}.rx{background-color:#064e3b;color:#a7f3d0;}</style></head><body>");
    
    html.push_str(&format!("<h1>ProbeTrace Capture Report: {}</h1>", capture.name));
    html.push_str("<div style='background-color:#1e293b;padding:16px;border-radius:8px;'>");
    html.push_str(&format!("<p><strong>Protocol Mode:</strong> {}</p>", capture.protocol));
    html.push_str(&format!("<p><strong>Capture Started:</strong> {}</p>", capture.started_at));
    html.push_str(&format!("<p><strong>Total Packets captured:</strong> {}</p>", capture.packet_count));
    html.push_str("</div>");

    html.push_str("<h2>Captured Protocol Packet List (Limit 500)</h2>");
    html.push_str("<table><thead><tr><th>ID</th><th>Timestamp (ns)</th><th>Dir</th><th>Len</th><th>Hex Bytes</th><th>Decoded</th></tr></thead><tbody>");
    for p in packets {
        let hex = hex::encode(&p.raw_bytes).to_uppercase();
        let dir_class = if p.direction == "TX" || p.direction == "MOSI" || p.direction == "Write" { "tx" } else { "rx" };
        html.push_str(&format!(
            "<tr><td>{}</td><td>{}</td><td><span class='badge {}'>{}</span></td><td>{}</td><td>{}</td><td>{}</td></tr>",
            p.id,
            p.timestamp_ns,
            dir_class,
            p.direction,
            p.raw_bytes.len(),
            hex,
            p.decoded_json.unwrap_or_default()
        ));
    }
    html.push_str("</tbody></table></body></html>");

    let mut file = File::create(&file_path).map_err(|e| e.to_string())?;
    file.write_all(html.as_bytes()).map_err(|e| e.to_string())?;

    Ok(())
}
