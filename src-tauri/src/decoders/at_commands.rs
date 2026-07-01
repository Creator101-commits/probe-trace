use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtCommandFrame {
    pub is_command: bool,
    pub command_name: String,
    pub command_type: String, // "EXECUTION", "SET", "READ", "TEST"
    pub description: String,
    pub parameters: Vec<String>,
    pub expected_response: String,
    pub is_response: bool,
    pub response_status: String, // "OK", "ERROR", "CME ERROR", "UNKNOWN"
    pub raw: String,
}

pub fn decode_at(bytes: &[u8]) -> Option<AtCommandFrame> {
    let raw = String::from_utf8_lossy(bytes).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    
    // Check if it's a response
    let upper = raw.to_uppercase();
    if upper == "OK" || upper == "ERROR" || upper.starts_with("ERROR:") || upper.starts_with("+CME ERROR:") || upper.starts_with("+CMS ERROR:") {
        let status = if upper == "OK" {
            "OK"
        } else if upper == "ERROR" {
            "ERROR"
        } else if upper.starts_with("+CME ERROR:") {
            "CME ERROR"
        } else {
            "ERROR"
        };
        
        return Some(AtCommandFrame {
            is_command: false,
            command_name: "".to_string(),
            command_type: "".to_string(),
            description: "Command Response".to_string(),
            parameters: vec![raw.clone()],
            expected_response: "".to_string(),
            is_response: true,
            response_status: status.to_string(),
            raw,
        });
    }

    // Check if it is an AT command (starts with AT, or A/)
    if !upper.starts_with("AT") && !upper.starts_with("A/") {
        // It could still be a response payload, like "+CSQ: 14,99"
        if raw.starts_with('+') {
            return Some(AtCommandFrame {
                is_command: false,
                command_name: "".to_string(),
                command_type: "UNSOLICITED_OR_RESULT".to_string(),
                description: "Unsolicited or Command Result".to_string(),
                parameters: vec![raw.clone()],
                expected_response: "".to_string(),
                is_response: true,
                response_status: "OK".to_string(),
                raw,
            });
        }
        return None;
    }

    // Parse Command
    // Strip "AT" (case insensitive)
    let cmd_part = if upper.starts_with("AT") {
        &raw[2..]
    } else {
        &raw[2..] // A/
    };

    let mut command_name = "".to_string();
    let mut command_type = "EXECUTION".to_string();
    let mut parameters = Vec::new();
    let mut description = "Unknown AT command".to_string();
    let mut expected_response = "OK".to_string();

    if cmd_part.is_empty() {
        return Some(AtCommandFrame {
            is_command: true,
            command_name: "AT".to_string(),
            command_type: "EXECUTION".to_string(),
            description: "Attention command (ping / handshake)".to_string(),
            parameters: vec![],
            expected_response: "OK".to_string(),
            is_response: false,
            response_status: "".to_string(),
            raw,
        });
    }

    // Separate cmd_part into command name and arguments
    // AT+CMD=value (SET), AT+CMD? (READ), AT+CMD=? (TEST), AT+CMD (EXECUTION)
    // Note: bare ATD (e.g. ATD123456789;) is also possible.
    if cmd_part.starts_with('D') || cmd_part.starts_with('d') {
        command_name = "ATD".to_string();
        command_type = "EXECUTION".to_string();
        description = "Dial command".to_string();
        parameters = vec![cmd_part[1..].to_string()];
        expected_response = "OK / CONNECT / NO CARRIER".to_string();
    } else {
        // Find split char: '=', '?', or end of string
        let eq_idx = cmd_part.find('=');
        let q_idx = cmd_part.find('?');

        match (eq_idx, q_idx) {
            (Some(eq), Some(q)) if q > eq => {
                // AT+CMD=? (TEST)
                command_name = format!("AT{}", &cmd_part[..eq]);
                command_type = "TEST".to_string();
                if q > eq + 1 {
                    parameters.push(cmd_part[eq+1..q].to_string());
                }
            }
            (Some(eq), None) => {
                // AT+CMD=value (SET)
                command_name = format!("AT{}", &cmd_part[..eq]);
                command_type = "SET".to_string();
                // Split parameters by comma
                let params_str = &cmd_part[eq+1..];
                parameters = params_str.split(',').map(|s| s.trim().to_string()).collect();
            }
            (None, Some(q)) => {
                // AT+CMD? (READ)
                command_name = format!("AT{}", &cmd_part[..q]);
                command_type = "READ".to_string();
            }
            _ => {
                // Bare command
                command_name = format!("AT{}", cmd_part);
                command_type = "EXECUTION".to_string();
            }
        }
    }

    // Lookup description and expected response in built-in database
    let upper_name = command_name.to_uppercase();
    match upper_name.as_str() {
        // GSM/SIM800
        "AT+CMGS" => {
            description = "Send SMS message".to_string();
            expected_response = "+CMGS: <mr> followed by OK".to_string();
        }
        "AT+CSQ" => {
            description = "Signal Quality Report".to_string();
            expected_response = "+CSQ: <rssi>,<ber> followed by OK".to_string();
        }
        "AT+CREG" => {
            description = "Network Registration status".to_string();
            expected_response = "+CREG: <n>,<stat> followed by OK".to_string();
        }
        "AT+CIPSTART" => {
            description = "Start TCP/UDP connection".to_string();
            expected_response = "CONNECT OK / ALREADY CONNECT / CONNECT FAIL".to_string();
        }
        // ESP8266 WiFi
        "AT+CWLAP" => {
            description = "Scan/List available WiFi Access Points".to_string();
            expected_response = "+CWLAP: <ecn>,<ssid>,<rssi>... followed by OK".to_string();
        }
        "AT+CWJAP" => {
            description = "Join/Connect to WiFi Access Point".to_string();
            expected_response = "WIFI CONNECTED / WIFI GOT IP followed by OK".to_string();
        }
        "AT+CIPSTATUS" => {
            description = "Get IP Connection Status".to_string();
            expected_response = "STATUS:<stat> followed by OK".to_string();
        }
        "AT+CIPSEND" => {
            description = "Send data over IP network connection".to_string();
            expected_response = "> prompt, then SEND OK".to_string();
        }
        // Bluetooth HC-05
        "AT+NAME" => {
            description = "Get/Set HC-05 device name".to_string();
            expected_response = "+NAME:<name> followed by OK".to_string();
        }
        "AT+PSWD" => {
            description = "Get/Set HC-05 device password/pairing code".to_string();
            expected_response = "+PSWD:<password> followed by OK".to_string();
        }
        "AT+ROLE" => {
            description = "Get/Set HC-05 connection role (0=Slave, 1=Master, 2=Loopback)".to_string();
            expected_response = "+ROLE:<role> followed by OK".to_string();
        }
        "AT+BIND" => {
            description = "Get/Set HC-05 bind address (for Master mode auto-connect)".to_string();
            expected_response = "+BIND:<address> followed by OK".to_string();
        }
        _ => {}
    }

    Some(AtCommandFrame {
        is_command: true,
        command_name,
        command_type,
        description,
        parameters,
        expected_response,
        is_response: false,
        response_status: "".to_string(),
        raw,
    })
}
