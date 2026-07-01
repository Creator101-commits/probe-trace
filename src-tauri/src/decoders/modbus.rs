use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModbusFrame {
    pub device_addr: u8,
    pub function_code: u8,
    pub function_name: String,
    pub registers: Vec<u16>,
    pub valid_crc: bool,
    pub is_error: bool,
    pub error_code: Option<u8>,
}

fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            if (crc & 0x0001) != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

pub fn decode_modbus(bytes: &[u8]) -> Option<ModbusFrame> {
    if bytes.len() < 4 {
        return None;
    }
    
    // The CRC is the last 2 bytes (little endian in Modbus RTU)
    let payload_len = bytes.len() - 2;
    let payload = &bytes[..payload_len];
    let crc_low = bytes[payload_len];
    let crc_high = bytes[payload_len + 1];
    let received_crc = ((crc_high as u16) << 8) | (crc_low as u16);
    
    let calculated_crc = crc16_modbus(payload);
    let valid_crc = received_crc == calculated_crc;
    
    let device_addr = payload[0];
    let function_code = payload[1];
    
    let is_error = (function_code & 0x80) != 0;
    let base_fn_code = if is_error { function_code & 0x7F } else { function_code };
    
    let function_name = match base_fn_code {
        1 => "Read Coils".to_string(),
        2 => "Read Discrete Inputs".to_string(),
        3 => "Read Holding Registers".to_string(),
        4 => "Read Input Registers".to_string(),
        5 => "Write Single Coil".to_string(),
        6 => "Write Single Register".to_string(),
        15 => "Write Multiple Coils".to_string(),
        16 => "Write Multiple Registers".to_string(),
        _ => format!("Unknown Function ({})", base_fn_code),
    };
    
    let mut registers = Vec::new();
    let mut error_code = None;
    
    if is_error {
        if payload.len() >= 3 {
            error_code = Some(payload[2]);
        }
    } else {
        // Parse data based on function code
        match base_fn_code {
            1 | 2 | 3 | 4 => {
                // If it's a response, byte 2 is the byte count
                // If it's a request, bytes 2-3 are start address, bytes 4-5 are quantity
                // Since requests/responses look different, let's parse depending on the length.
                // Usually a request is 8 bytes total: [addr, fn, start_h, start_l, quant_h, quant_l, crc_l, crc_h]
                if bytes.len() == 8 {
                    let start_addr = ((payload[2] as u16) << 8) | (payload[3] as u16);
                    let quantity = ((payload[4] as u16) << 8) | (payload[5] as u16);
                    registers.push(start_addr);
                    registers.push(quantity);
                } else if payload.len() >= 3 {
                    // Response: [addr, fn, byte_count, data...]
                    let byte_count = payload[2] as usize;
                    if base_fn_code == 3 || base_fn_code == 4 {
                        // 16-bit registers (pairs of bytes)
                        for idx in (3..payload.len()).step_by(2) {
                            if idx + 1 < payload.len() {
                                let val = ((payload[idx] as u16) << 8) | (payload[idx + 1] as u16);
                                registers.push(val);
                            }
                        }
                    } else {
                        // Coils / Discrete inputs - 1-bit values packed into bytes
                        for idx in 3..payload.len() {
                            registers.push(payload[idx] as u16);
                        }
                    }
                }
            }
            5 | 6 => {
                // Write Single Coil / Register (both request and response have 8 bytes total)
                // [addr, fn, reg_addr_h, reg_addr_l, value_h, value_l, crc_l, crc_h]
                if payload.len() >= 6 {
                    let reg_addr = ((payload[2] as u16) << 8) | (payload[3] as u16);
                    let value = ((payload[4] as u16) << 8) | (payload[5] as u16);
                    registers.push(reg_addr);
                    registers.push(value);
                }
            }
            15 | 16 => {
                // Write Multiple Coils / Registers
                // Request: [addr, fn, start_h, start_l, quant_h, quant_l, byte_cnt, data..., crc...]
                // Response: [addr, fn, start_h, start_l, quant_h, quant_l, crc...] (8 bytes total)
                if bytes.len() == 8 {
                    // Response
                    let start_addr = ((payload[2] as u16) << 8) | (payload[3] as u16);
                    let quantity = ((payload[4] as u16) << 8) | (payload[5] as u16);
                    registers.push(start_addr);
                    registers.push(quantity);
                } else if payload.len() >= 6 {
                    // Request
                    let start_addr = ((payload[2] as u16) << 8) | (payload[3] as u16);
                    let quantity = ((payload[4] as u16) << 8) | (payload[5] as u16);
                    registers.push(start_addr);
                    registers.push(quantity);
                    
                    if base_fn_code == 16 && payload.len() >= 7 {
                        for idx in (7..payload.len()).step_by(2) {
                            if idx + 1 < payload.len() {
                                let val = ((payload[idx] as u16) << 8) | (payload[idx + 1] as u16);
                                registers.push(val);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Some(ModbusFrame {
        device_addr,
        function_code,
        function_name,
        registers,
        valid_crc,
        is_error,
        error_code,
    })
}
