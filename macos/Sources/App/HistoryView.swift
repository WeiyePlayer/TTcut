import SwiftUI
import TTcutCore

struct HistoryView: View {
  @EnvironmentObject var state: AppState
  @State private var deletion: String?
  @State private var clear = false
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Text("历史剪辑").font(.largeTitle.bold())
          Text("重新使用已完成的本地分析，无需再次标定和等待分析。").foregroundStyle(.secondary)
        }
        Spacer()
        Button("清空历史", role: .destructive) { clear = true }.disabled(
          state.busy || state.history.isEmpty)
        Button("刷新") { Task { await state.refreshHistory() } }
      }
      if state.history.isEmpty {
        ContentUnavailableView(
          "还没有历史记录", systemImage: "clock.arrow.circlepath",
          description: Text("完成一次包含有效回合的视频分析后，记录会显示在这里。"))
      } else {
        ScrollView {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 18)], spacing: 18) {
            ForEach(state.history) { entry in
              VStack(alignment: .leading, spacing: 10) {
                ZStack {
                  Rectangle().fill(.black.opacity(0.1))
                  if let cover = entry.coverURL, let image = NSImage(contentsOf: cover) {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
                  } else {
                    Image(systemName: "video.slash").foregroundStyle(.secondary)
                  }
                }.aspectRatio(16 / 9, contentMode: .fit).clipShape(
                  RoundedRectangle(cornerRadius: 8))
                Text(entry.record.sourceVideo.name).font(.headline).lineLimit(1)
                Text("\(entry.record.rallies.count) 个回合").font(.caption)
                Text(entry.record.createdAt, style: .date).font(.caption).foregroundStyle(
                  .secondary)
                Text(sourceStatus(entry.status)).font(.caption).foregroundStyle(
                  entry.status == .available ? Color.secondary : Color.orange)
                HStack {
                  Button("打开") { state.openHistory(entry) }.disabled(
                    entry.status != .available || state.busy)
                  if let output = entry.record.outputPath {
                    Button("查看导出") {
                      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: output)])
                    }
                  }
                  Spacer()
                  Button(role: .destructive) {
                    deletion = entry.id
                  } label: {
                    Image(systemName: "trash")
                  }.disabled(state.busy)
                }
              }.card()
            }
          }.padding(2)
        }
      }
    }.padding(28)
      .confirmationDialog(
        "删除历史记录",
        isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }),
        titleVisibility: .visible
      ) {
        Button("确认删除", role: .destructive) {
          if let id = deletion { state.deleteHistory(id) }
          deletion = nil
        }
      } message: {
        Text("只删除分析记录和封面，源视频及导出视频会保留。")
      }
      .confirmationDialog("清空全部历史", isPresented: $clear, titleVisibility: .visible) {
        Button("确认删除", role: .destructive) {
          Task {
            do {
              try await state.store.clear()
              await state.refreshHistory()
            } catch { state.message = error.localizedDescription }
          }
        }
      } message: {
        Text("只删除分析记录和封面，源视频及导出视频会保留。")
      }
  }
  func sourceStatus(_ status: SourceStatus) -> LocalizedStringKey {
    switch status {
    case .available: return "可继续剪辑"
    case .missing: return "源视频已移动或删除"
    case .changed: return "源视频已变化，请重新分析"
    case .processingMissing: return "固定帧率媒体丢失，请重新分析"
    }
  }
}
