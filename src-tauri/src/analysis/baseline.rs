use serde::{Serialize, Deserialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricStats {
    pub mean: f64,
    pub std_dev: f64,
    pub min: f64,
    pub max: f64,
    pub percentile_95: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProtocolBaseline {
    // UART Metrics
    pub uart_inter_arrival_ms: Option<MetricStats>,
    pub uart_packet_length: Option<MetricStats>,
    pub uart_byte_distribution: HashMap<u8, f64>, // byte -> percentage

    // I2C Metrics
    pub i2c_expected_ack: HashMap<u8, Vec<bool>>, // address -> expected ACK/NACK sequence pattern
    pub i2c_transaction_length: HashMap<u8, MetricStats>, // address -> length stats

    // SPI Metrics
    pub spi_frame_length: Option<MetricStats>,
    pub spi_cs_pulse_width_ms: Option<MetricStats>,
}

pub struct BaselineCollector {
    pub start_time_ns: i64,
    pub packet_count: usize,
    
    // Raw collections for statistics
    pub uart_inter_arrivals: Vec<f64>,
    pub uart_lengths: Vec<f64>,
    pub uart_bytes: HashMap<u8, usize>,
    
    pub i2c_acks: HashMap<u8, Vec<Vec<bool>>>,
    pub i2c_lengths: HashMap<u8, Vec<f64>>,
    
    pub spi_lengths: Vec<f64>,
    pub spi_pulse_widths: Vec<f64>,
}

impl BaselineCollector {
    pub fn new(start_time_ns: i64) -> Self {
        Self {
            start_time_ns,
            packet_count: 0,
            uart_inter_arrivals: Vec::new(),
            uart_lengths: Vec::new(),
            uart_bytes: HashMap::new(),
            i2c_acks: HashMap::new(),
            i2c_lengths: HashMap::new(),
            spi_lengths: Vec::new(),
            spi_pulse_widths: Vec::new(),
        }
    }

    pub fn add_packet(&mut self, timestamp_ns: i64, protocol: &str, raw_bytes: &[u8], _direction: &str, decoded_json: &Option<String>, prev_timestamp_ns: Option<i64>) {
        self.packet_count += 1;
        
        match protocol {
            "UART" => {
                if let Some(prev) = prev_timestamp_ns {
                    let diff_ms = (timestamp_ns - prev) as f64 / 1_000_000.0;
                    if diff_ms > 0.0 {
                        self.uart_inter_arrivals.push(diff_ms);
                    }
                }
                self.uart_lengths.push(raw_bytes.len() as f64);
                for &b in raw_bytes {
                    *self.uart_bytes.entry(b).or_insert(0) += 1;
                }
            }
            "I2C" => {
                if let Some(json_str) = decoded_json {
                    if let Ok(i2c_pkt) = serde_json::from_str::<serde_json::Value>(json_str) {
                        let address = i2c_pkt["address"].as_u64().unwrap_or(0) as u8;
                        let _direction = i2c_pkt["direction"].as_str().unwrap_or("");
                        let data_len = i2c_pkt["data_bytes"].as_array().map(|a| a.len()).unwrap_or(0);
                        let acks = i2c_pkt["ack_flags"].as_array()
                            .map(|a| a.iter().map(|v| v.as_bool().unwrap_or(false)).collect::<Vec<bool>>())
                            .unwrap_or_default();
                        
                        self.i2c_acks.entry(address).or_insert_with(Vec::new).push(acks);
                        self.i2c_lengths.entry(address).or_insert_with(Vec::new).push(data_len as f64);
                    }
                }
            }
            "SPI" => {
                // SPI has both MOSI and MISO packets. We can use MOSI packet or MISO to check length and pulse width.
                // For simplicity, typical CS pulse width could be simulated or extracted.
                // Since raw_bytes represents MOSI or MISO frame:
                self.spi_lengths.push(raw_bytes.len() as f64);
                
                // Let's calculate typical pulse width based on data transfer time or simulated pulse width
                // For SPI, typical frame has active CS. We can simulate the CS pulse width (e.g. 0.1ms per byte at 100kbps)
                let simulated_cs_width = raw_bytes.len() as f64 * 0.08; // 0.08ms per byte
                self.spi_pulse_widths.push(simulated_cs_width);
            }
            _ => {}
        }
    }

    pub fn calculate(&self) -> ProtocolBaseline {
        let uart_inter_arrival_ms = calculate_stats(&self.uart_inter_arrivals);
        let uart_packet_length = calculate_stats(&self.uart_lengths);
        
        let mut uart_byte_distribution = HashMap::new();
        let total_bytes: usize = self.uart_bytes.values().sum();
        if total_bytes > 0 {
            for (&b, &count) in &self.uart_bytes {
                uart_byte_distribution.insert(b, count as f64 / total_bytes as f64);
            }
        }
        
        let mut i2c_expected_ack = HashMap::new();
        for (&addr, ack_lists) in &self.i2c_acks {
            if !ack_lists.is_empty() {
                // Find the most common ACK sequence length
                let mut len_counts = HashMap::new();
                for list in ack_lists {
                    *len_counts.entry(list.len()).or_insert(0) += 1;
                }
                let best_len = len_counts.into_iter().max_by_key(|&(_, count)| count).map(|(l, _)| l).unwrap_or(0);
                
                // Construct a consensus ACK pattern
                let mut consensus = vec![false; best_len];
                for i in 0..best_len {
                    let mut true_count = 0;
                    let mut total = 0;
                    for list in ack_lists {
                        if i < list.len() {
                            if list[i] { true_count += 1; }
                            total += 1;
                        }
                    }
                    if total > 0 {
                        consensus[i] = (true_count as f64 / total as f64) >= 0.5;
                    }
                }
                i2c_expected_ack.insert(addr, consensus);
            }
        }
        
        let mut i2c_transaction_length = HashMap::new();
        for (&addr, lens) in &self.i2c_lengths {
            if let Some(stats) = calculate_stats(lens) {
                i2c_transaction_length.insert(addr, stats);
            }
        }
        
        let spi_frame_length = calculate_stats(&self.spi_lengths);
        let spi_cs_pulse_width_ms = calculate_stats(&self.spi_pulse_widths);
        
        ProtocolBaseline {
            uart_inter_arrival_ms,
            uart_packet_length,
            uart_byte_distribution,
            i2c_expected_ack,
            i2c_transaction_length,
            spi_frame_length,
            spi_cs_pulse_width_ms,
        }
    }
}

fn calculate_stats(values: &[f64]) -> Option<MetricStats> {
    if values.is_empty() {
        return None;
    }
    
    let count = values.len() as f64;
    let mean: f64 = values.iter().sum::<f64>() / count;
    
    let variance: f64 = values.iter().map(|&v| {
        let diff = v - mean;
        diff * diff
    }).sum::<f64>() / count;
    
    let std_dev = variance.sqrt();
    
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    
    let min = sorted[0];
    let max = sorted[sorted.len() - 1];
    
    let idx = ((sorted.len() - 1) as f64 * 0.95).round() as usize;
    let percentile_95 = sorted[idx];
    
    Some(MetricStats {
        mean,
        std_dev,
        min,
        max,
        percentile_95,
    })
}
