import Foundation

let process = ProcessInfo.processInfo
let value: [String: Any] = [
  "timestamp": ISO8601DateFormatter().string(from: Date()),
  "thermal_state": process.thermalState.rawValue,
  "thermal_state_labels": ["nominal", "fair", "serious", "critical"],
  "low_power_mode": process.isLowPowerModeEnabled,
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
