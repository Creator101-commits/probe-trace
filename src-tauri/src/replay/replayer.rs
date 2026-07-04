use serde::{Serialize, Deserialize};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use crate::db::Db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayState {
    pub current_packet_index: usize,
    pub total_packets: usize,
    pub elapsed_ms: u64,
    pub status: String, // "Playing", "Paused", "Done"
}

pub struct TrafficReplayer {
    pub capture_id: i64,
    pub stop_signal: Arc<AtomicBool>,
    pub pause_signal: Arc<AtomicBool>,
    pub state: Arc<Mutex<ReplayState>>,
}

impl TrafficReplayer {
    pub fn start(
        app_handle: AppHandle,
        db: Arc<Db>,
        capture_id: i64,
        speed: f64, // e.g. 0.5, 1.0, 2.0, 10.0. 0.0 means instant
        filter_direction: Option<String>,
        filter_pattern: Option<String>,
    ) -> Result<Self, String> {
        // Load all packets for this capture from SQLite
        let mut packets = db.get_packets(capture_id, 0, 100000).map_err(|e| e.to_string())?;

        // Apply filters
        if let Some(ref dir) = filter_direction {
            if dir != "All" {
                packets.retain(|p| p.direction == *dir);
            }
        }

        if let Some(ref pattern) = filter_pattern {
            if !pattern.is_empty() {
                let lower_pat = pattern.to_lowercase();
                packets.retain(|p| {
                    let hex_str = hex::encode(&p.raw_bytes).to_lowercase();
                    let ascii_str = p.raw_bytes.iter().map(|&b| b as char).collect::<String>().to_lowercase();
                    hex_str.contains(&lower_pat) || ascii_str.contains(&lower_pat)
                });
            }
        }

        let total_packets = packets.len();
        let stop_signal = Arc::new(AtomicBool::new(false));
        let pause_signal = Arc::new(AtomicBool::new(false));

        let replay_state = Arc::new(Mutex::new(ReplayState {
            current_packet_index: 0,
            total_packets,
            elapsed_ms: 0,
            status: "Playing".to_string(),
        }));

        let stop_signal_clone = stop_signal.clone();
        let pause_signal_clone = pause_signal.clone();
        let replay_state_clone = replay_state.clone();

        std::thread::spawn(move || {
            let start_time = std::time::Instant::now();
            let mut last_packet_time_ns: Option<i64> = None;

            for (idx, packet) in packets.iter().enumerate() {
                if stop_signal_clone.load(Ordering::SeqCst) {
                    break;
                }

                // Check pause signal
                while pause_signal_clone.load(Ordering::SeqCst) {
                    if stop_signal_clone.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }

                // Timing preservation
                if let Some(last_ns) = last_packet_time_ns {
                    let diff_ns = packet.timestamp_ns - last_ns;
                    if diff_ns > 0 && speed > 0.0 {
                        // calculate delay taking speed multiplier into account
                        let delay_ns = (diff_ns as f64 / speed) as u64;
                        // wait in smaller chunks to be responsive to pause/stop signals
                        let chunk_size = Duration::from_millis(10);
                        let total_delay = Duration::from_nanos(delay_ns);
                        let mut elapsed = Duration::from_secs(0);

                        while elapsed < total_delay {
                            if stop_signal_clone.load(Ordering::SeqCst) {
                                return;
                            }
                            while pause_signal_clone.load(Ordering::SeqCst) {
                                if stop_signal_clone.load(Ordering::SeqCst) {
                                    return;
                                }
                                std::thread::sleep(Duration::from_millis(50));
                            }
                            let sleep_time = chunk_size.min(total_delay - elapsed);
                            std::thread::sleep(sleep_time);
                            elapsed += sleep_time;
                        }
                    }
                }
                last_packet_time_ns = Some(packet.timestamp_ns);

                // Send/Transmit bytes (in a real app, this goes to the physical serial port)
                // For simulator purposes, we emit a packet transmission signal, and we can also emit the packet
                // as a simulated Rx/Tx packet so the packet list updates.
                let _ = app_handle.emit("packet-transmitted", packet.clone());
                // Also duplicate packet back into the current capture session so it shows up in real time
                let _ = app_handle.emit("packet-received", packet.clone());

                // Update state
                let elapsed = start_time.elapsed().as_millis() as u64;
                {
                    let mut st = replay_state_clone.lock().unwrap();
                    st.current_packet_index = idx + 1;
                    st.elapsed_ms = elapsed;
                    if st.current_packet_index == st.total_packets {
                        st.status = "Done".to_string();
                    }
                    let _ = app_handle.emit("replay-state-changed", st.clone());
                }
            }

            // Mark done if finished loop
            {
                let mut st = replay_state_clone.lock().unwrap();
                st.status = "Done".to_string();
                let _ = app_handle.emit("replay-state-changed", st.clone());
            }
        });

        Ok(Self {
            capture_id,
            stop_signal,
            pause_signal,
            state: replay_state,
        })
    }

    pub fn pause(&self) {
        self.pause_signal.store(true, Ordering::SeqCst);
        let mut st = self.state.lock().unwrap();
        st.status = "Paused".to_string();
    }

    pub fn resume(&self) {
        self.pause_signal.store(false, Ordering::SeqCst);
        let mut st = self.state.lock().unwrap();
        st.status = "Playing".to_string();
    }

    pub fn stop(&self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        let mut st = self.state.lock().unwrap();
        st.status = "Done".to_string();
    }
}
