import CoreML
import Foundation

let configuration = MLModelConfiguration()
switch CommandLine.arguments[2] {
case "ane": configuration.computeUnits = .cpuAndNeuralEngine
case "all": configuration.computeUnits = .all
default: configuration.computeUnits = .cpuAndGPU
}
let plan = try await MLComputePlan.load(
  contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]), configuration: configuration)
var operations: [[String: Any]] = []
func visit(_ block: MLModelStructure.Program.Block) {
  for operation in block.operations {
    let device: String
    if let usage = plan.deviceUsage(for: operation) {
      switch usage.preferred {
      case .cpu: device = "cpu"
      case .gpu: device = "gpu"
      case .neuralEngine: device = "neuralEngine"
      @unknown default: device = "unknown"
      }
    } else { device = "unreported" }
    operations.append([
      "operator": operation.operatorName, "outputs": operation.outputs.map(\.name),
      "preferred_device": device, "estimated_cost": plan.estimatedCost(of: operation)?.weight ?? 0,
    ])
    operation.blocks.forEach(visit)
  }
}
if case let .program(program) = plan.modelStructure { program.functions.values.forEach { visit($0.block) } }
let data = try JSONSerialization.data(withJSONObject: [
  "configuration": CommandLine.arguments[2],
  "scope": "Model compute plan, not a per-prediction hardware trace at the video input shape",
  "operations": operations,
], options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
