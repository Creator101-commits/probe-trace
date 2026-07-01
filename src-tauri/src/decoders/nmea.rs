use std::collections::HashMap;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NmeaFrame {
    pub sentence_type: String,
    pub fields: HashMap<String, String>,
    pub valid_checksum: bool,
    pub raw: String,
}

pub fn decode_nmea(bytes: &[u8]) -> Option<NmeaFrame> {
    let raw = String::from_utf8_lossy(bytes).trim().to_string();
    if !raw.starts_with('$') {
        return None;
    }
    
    // Find checksum separator
    let asterisk_pos = raw.find('*');
    let (payload, expected_checksum_str) = if let Some(pos) = asterisk_pos {
        let (p, c) = raw.split_at(pos);
        (p, c.strip_prefix('*').unwrap_or(""))
    } else {
        (raw.as_str(), "")
    };

    // Calculate checksum of payload (excluding '$')
    let mut calculated_checksum = 0u8;
    for &b in payload.as_bytes().iter().skip(1) {
        calculated_checksum ^= b;
    }

    let valid_checksum = if !expected_checksum_str.is_empty() {
        if let Ok(expected_checksum) = u8::from_str_radix(expected_checksum_str, 16) {
            calculated_checksum == expected_checksum
        } else {
            false
        }
    } else {
        false
    };

    // Parse CSV fields from payload
    let csv_part = payload.strip_prefix('$').unwrap_or(payload);
    let mut fields_iter = csv_part.split(',');
    let sentence_type = fields_iter.next().unwrap_or("").to_string();
    
    let parts: Vec<&str> = fields_iter.collect();
    let mut fields = HashMap::new();

    match sentence_type.as_str() {
        "GPRMC" => {
            // $GPRMC,hhmmss.ss,A,llll.ll,a,yyyyy.yy,a,x.x,x.x,ddmmyy,,,a*hh
            // 0: time (UTC)
            // 1: Status (A=OK, V=Warning)
            // 2: Lat
            // 3: N/S
            // 4: Lon
            // 5: E/W
            // 6: Speed (knots)
            // 7: Course (degrees)
            // 8: Date (ddmmyy)
            if parts.len() >= 9 {
                fields.insert("time".to_string(), parts[0].to_string());
                fields.insert("status".to_string(), parts[1].to_string());
                fields.insert("latitude".to_string(), format_lat_lon(parts[2], parts[3]));
                fields.insert("longitude".to_string(), format_lat_lon(parts[4], parts[5]));
                fields.insert("speed_knots".to_string(), parts[6].to_string());
                fields.insert("course".to_string(), parts[7].to_string());
                fields.insert("date".to_string(), parts[8].to_string());
                // For live map plotting, let's also store decimal latitude and longitude
                if let (Some(lat_dec), Some(lon_dec)) = (parse_lat_lon_to_decimal(parts[2], parts[3]), parse_lat_lon_to_decimal(parts[4], parts[5])) {
                    fields.insert("latitude_dec".to_string(), lat_dec.to_string());
                    fields.insert("longitude_dec".to_string(), lon_dec.to_string());
                }
            }
        }
        "GPGGA" => {
            // $GPGGA,hhmmss.ss,llll.ll,a,yyyyy.yy,a,x,xx,x.x,g.g,M,g.g,M,x.x,xxxx*hh
            // 0: UTC time
            // 1: Lat
            // 2: N/S
            // 3: Lon
            // 4: E/W
            // 5: Fix quality (0=invalid, 1=GPS fix, 2=DGPS fix, etc.)
            // 6: Satellites tracked
            // 7: HDOP
            // 8: Altitude
            // 9: Altitude units (M)
            if parts.len() >= 9 {
                fields.insert("time".to_string(), parts[0].to_string());
                fields.insert("latitude".to_string(), format_lat_lon(parts[1], parts[2]));
                fields.insert("longitude".to_string(), format_lat_lon(parts[3], parts[4]));
                fields.insert("fix_quality".to_string(), parts[5].to_string());
                fields.insert("satellites".to_string(), parts[6].to_string());
                fields.insert("hdop".to_string(), parts[7].to_string());
                fields.insert("altitude".to_string(), format!("{} {}", parts[8], parts[9]));
            }
        }
        "GPGSV" => {
            // $GPGSV,no_msg,msg_no,no_sv,sv_prn,elev,azimuth,snr,...
            // 0: Total number of messages
            // 1: Message number
            // 2: Total number of SVs in view
            // 3..: SV PRN, Elevation, Azimuth, SNR (repeats up to 4 times)
            if parts.len() >= 3 {
                fields.insert("total_messages".to_string(), parts[0].to_string());
                fields.insert("message_number".to_string(), parts[1].to_string());
                fields.insert("satellites_in_view".to_string(), parts[2].to_string());
                
                let mut sat_list = Vec::new();
                let mut idx = 3;
                while idx + 3 < parts.len() {
                    let prn = parts[idx];
                    let elevation = parts[idx + 1];
                    let azimuth = parts[idx + 2];
                    let snr = parts[idx + 3];
                    if !prn.is_empty() {
                        sat_list.push(format!("PRN:{},Elev:{}°,Azim:{}°,SNR:{}dB", prn, elevation, azimuth, snr));
                    }
                    idx += 4;
                }
                fields.insert("satellites_info".to_string(), sat_list.join(" | "));
            }
        }
        "GPVTG" => {
            // $GPVTG,x.x,T,x.x,M,x.x,N,x.x,K,a*hh
            // 0: Track made good (degrees true)
            // 1: T
            // 2: Track made good (degrees magnetic)
            // 3: M
            // 4: Speed in knots
            // 5: N
            // 6: Speed in km/h
            // 7: K
            if parts.len() >= 8 {
                fields.insert("track_true".to_string(), format!("{}° {}", parts[0], parts[1]));
                fields.insert("track_magnetic".to_string(), format!("{}° {}", parts[2], parts[3]));
                fields.insert("speed_knots".to_string(), format!("{} {}", parts[4], parts[5]));
                fields.insert("speed_kmh".to_string(), format!("{} {}", parts[6], parts[7]));
            }
        }
        _ => {
            // Generic sentence parsing: insert all fields numbered
            for (i, p) in parts.iter().enumerate() {
                fields.insert(format!("field_{}", i), p.to_string());
            }
        }
    }

    Some(NmeaFrame {
        sentence_type,
        fields,
        valid_checksum,
        raw,
    })
}

fn format_lat_lon(val: &str, dir: &str) -> String {
    if val.is_empty() {
        return "".to_string();
    }
    if val.len() >= 4 {
        let (deg, min) = val.split_at(val.len() - 7);
        format!("{}° {}' {}", deg, min, dir)
    } else {
        format!("{} {}", val, dir)
    }
}

fn parse_lat_lon_to_decimal(val: &str, dir: &str) -> Option<f64> {
    if val.is_empty() || dir.is_empty() {
        return None;
    }
    let dot_pos = val.find('.')?;
    if dot_pos < 2 {
        return None;
    }
    let deg_len = dot_pos - 2;
    let deg_str = &val[..deg_len];
    let min_str = &val[deg_len..];
    
    let deg: f64 = deg_str.parse().ok()?;
    let min: f64 = min_str.parse().ok()?;
    let mut decimal = deg + (min / 60.0);
    
    if dir == "S" || dir == "W" {
        decimal = -decimal;
    }
    Some(decimal)
}
