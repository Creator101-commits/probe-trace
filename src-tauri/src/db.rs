use rusqlite::{params, Connection, Result};
use std::sync::Mutex;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capture {
    pub id: i64,
    pub name: String,
    pub protocol: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub packet_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Packet {
    pub id: i64,
    pub timestamp_ns: i64,
    pub protocol: String,
    pub raw_bytes: Vec<u8>,
    pub direction: String,
    pub decoded_json: Option<String>,
}

pub struct Db {
    pub conn: Mutex<Connection>,
}

impl Db {
    pub fn new(path: &std::path::Path) -> Self {
        let conn = Connection::open(path).expect("Failed to open database");
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS captures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                protocol TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                packet_count INTEGER DEFAULT 0
            );",
            [],
        ).expect("Failed to create captures table");

        conn.execute(
            "CREATE TABLE IF NOT EXISTS packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                capture_id INTEGER NOT NULL,
                timestamp_ns INTEGER NOT NULL,
                protocol TEXT NOT NULL,
                direction TEXT NOT NULL,
                raw_bytes_hex TEXT NOT NULL,
                decoded_json TEXT,
                FOREIGN KEY(capture_id) REFERENCES captures(id)
            );",
            [],
        ).expect("Failed to create packets table");

        Db { conn: Mutex::new(conn) }
    }

    pub fn create_capture(&self, protocol: String) -> Result<Capture> {
        let conn = self.conn.lock().unwrap();
        let started_at = chrono::Utc::now().to_rfc3339();
        let name = format!("{}_{}", protocol, chrono::Utc::now().format("%Y%m%d_%H%M%S"));
        
        conn.execute(
            "INSERT INTO captures (name, protocol, started_at, packet_count) VALUES (?1, ?2, ?3, 0)",
            params![name, protocol, started_at],
        )?;
        
        let id = conn.last_insert_rowid();
        
        Ok(Capture {
            id,
            name,
            protocol,
            started_at,
            ended_at: None,
            packet_count: 0,
        })
    }

    pub fn save_packet(&self, capture_id: i64, packet: &Packet) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let raw_bytes_hex = hex::encode(&packet.raw_bytes);
        
        conn.execute(
            "INSERT INTO packets (capture_id, timestamp_ns, protocol, direction, raw_bytes_hex, decoded_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                capture_id,
                packet.timestamp_ns,
                packet.protocol,
                packet.direction,
                raw_bytes_hex,
                packet.decoded_json
            ],
        )?;

        // Update packet count
        conn.execute(
            "UPDATE captures SET packet_count = packet_count + 1 WHERE id = ?1",
            params![capture_id],
        )?;
        
        Ok(())
    }

    pub fn save_packets_batch(&self, capture_id: i64, packets: &[Packet]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO packets (capture_id, timestamp_ns, protocol, direction, raw_bytes_hex, decoded_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
            )?;
            for packet in packets {
                let raw_bytes_hex = hex::encode(&packet.raw_bytes);
                stmt.execute(params![
                    capture_id,
                    packet.timestamp_ns,
                    packet.protocol,
                    packet.direction,
                    raw_bytes_hex,
                    packet.decoded_json
                ])?;
            }
        }
        tx.execute(
            "UPDATE captures SET packet_count = packet_count + ?1 WHERE id = ?2",
            params![packets.len() as i64, capture_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get_packets(&self, capture_id: i64, offset: i64, limit: i64) -> Result<Vec<Packet>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, timestamp_ns, protocol, direction, raw_bytes_hex, decoded_json FROM packets
             WHERE capture_id = ?1 ORDER BY id ASC LIMIT ?2 OFFSET ?3"
        )?;
        
        let packet_iter = stmt.query_map(params![capture_id, limit, offset], |row| {
            let id: i64 = row.get(0)?;
            let timestamp_ns: i64 = row.get(1)?;
            let protocol: String = row.get(2)?;
            let direction: String = row.get(3)?;
            let raw_bytes_hex: String = row.get(4)?;
            let decoded_json: Option<String> = row.get(5)?;
            
            let raw_bytes = hex::decode(raw_bytes_hex).unwrap_or_default();
            
            Ok(Packet {
                id,
                timestamp_ns,
                protocol,
                raw_bytes,
                direction,
                decoded_json,
            })
        })?;
        
        let mut packets = Vec::new();
        for packet in packet_iter {
            packets.push(packet?);
        }
        
        Ok(packets)
    }

    pub fn end_capture(&self, capture_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let ended_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE captures SET ended_at = ?1 WHERE id = ?2",
            params![ended_at, capture_id],
        )?;
        Ok(())
    }
}
