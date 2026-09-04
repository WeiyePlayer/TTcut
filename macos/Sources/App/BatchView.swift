import SwiftUI
import TTcutCore

struct BatchView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Text("批量任务").font(.largeTitle.bold())
          Text("自动识别各视频球桌；识别失败时可手动补充。").foregroundStyle(.secondary)
        }
        Spacer()
        Button("添加视频") { state.addBatch() }.disabled(state.busy)
      }
      if state.batch.isEmpty {
        ContentUnavailableView("添加视频开始批量任务", systemImage: "square.stack.3d.up")
      } else {
        List {
          ForEach($state.batch) { $item in
            VStack(alignment: .leading, spacing: 10) {
              HStack {
                Image(systemName: "film").foregroundStyle(.blue)
                Text(item.url.lastPathComponent).font(.headline).lineLimit(1)
                Spacer()
                Text(status(item.status)).foregroundStyle(
                  item.status == .failed || item.status == .manualRequired
                    ? Color.orange : Color.secondary)
              }
              HStack {
                Picker("模式", selection: $item.mode) {
                  Text("所有回合").tag(CutMode.all)
                  Text("精彩回合").tag(CutMode.highlight)
                  Text("只分析").tag(CutMode.analyzeOnly)
                }.frame(width: 200).disabled(state.busy || item.status == .done)
                if item.mode == .highlight {
                  Picker("大于", selection: $item.threshold) {
                    Text("3 板").tag(3)
                    Text("5 板").tag(5)
                    Text("7 板").tag(7)
                  }.frame(width: 130).disabled(state.busy)
                }
                Spacer()
                if item.status == .manualRequired {
                  Button("手动标定") { state.manuallyCalibrateBatch(item.id) }.disabled(state.busy)
                }
                if item.result != nil {
                  Button("查看回合") { state.reviewBatch(item.id) }.disabled(state.busy)
                }
                if let output = item.output {
                  Button("打开输出") { NSWorkspace.shared.activateFileViewerSelecting([output]) }
                }
                Button(role: .destructive) {
                  state.batch.removeAll { $0.id == item.id }
                } label: {
                  Image(systemName: "trash")
                }.disabled(state.busy)
              }
              if item.status == .running || item.status == .exporting {
                ProgressView(value: item.progress)
              }
              if let error = item.error {
                Text(error).font(.caption).foregroundStyle(.orange).lineLimit(3).textSelection(
                  .enabled)
              }
            }.padding(.vertical, 10)
          }
        }.listStyle(.inset)
      }
      HStack {
        if let destination = state.batchDestination {
          Text(destination.path).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
        if state.busy { Button("取消", role: .destructive) { state.cancel() } }
        Button("开始分析剪辑") { state.runBatch() }.buttonStyle(.borderedProminent).disabled(
          state.busy || state.batch.isEmpty)
      }
    }.padding(28)
  }
  func status(_ value: BatchStatus) -> LocalizedStringKey {
    switch value {
    case .pending: return "等待处理"
    case .calibrating: return "正在标定球桌"
    case .running: return "正在分析"
    case .exporting: return "正在导出"
    case .done: return "已完成"
    case .failed: return "处理失败"
    case .manualRequired: return "需要手动标定"
    }
  }
}
