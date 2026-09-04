import AVKit
import AppKit
import SwiftUI
import TTcutCore

struct RootView: View {
  @EnvironmentObject var state: AppState
  @State private var collapsed = false
  var isCollapsed: Bool {
    collapsed || (state.page == .cut && state.flow == .review && state.mode == .custom)
  }
  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          BundleImage(name: "ttcut-icon").frame(width: 32, height: 32)
          if !isCollapsed { Text("TTcut").font(.title2.bold()) }
          Spacer()
          Button {
            collapsed.toggle()
          } label: {
            Image(systemName: "sidebar.left")
          }.buttonStyle(.plain)
        }.padding(.horizontal, 16).frame(height: 62)
        ForEach([Page.cut, Page.history], id: \.self) { page in
          Button {
            state.page = page
          } label: {
            HStack(spacing: 12) {
              Image(systemName: icon(page)).frame(width: 24)
              if !isCollapsed {
                Text(state.english ? english(page) : page.rawValue)
                Spacer()
              }
            }.padding(.horizontal, 14).frame(height: 44).background(
              (state.page == page || (page == .cut && state.page == .batch))
                ? Color.accentColor.opacity(0.13) : .clear
            ).clipShape(RoundedRectangle(cornerRadius: 10))
          }.buttonStyle(.plain)
        }
        Spacer()
        Button {
          state.page = .settings
        } label: {
          HStack {
            Image(systemName: "gearshape").frame(width: 24)
            if !isCollapsed {
              Text("设置")
              Spacer()
            }
          }.padding(14)
        }.buttonStyle(.plain)
        if !isCollapsed {
          Text("macOS · Apple Silicon").font(.caption).foregroundStyle(.secondary).padding(16)
        }
      }.frame(width: isCollapsed ? 72 : 220).background(Color(nsColor: .windowBackgroundColor))
      Divider()
      Group {
        switch state.page {
        case .cut: CutView()
        case .batch: BatchView()
        case .history: HistoryView()
        case .settings: SettingsView()
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity).background(
        Color(nsColor: .controlBackgroundColor))
    }.alert(
      "TTcut",
      isPresented: Binding(get: { state.message != nil }, set: { if !$0 { state.message = nil } })
    ) {
      Button("好", role: .cancel) { state.message = nil }
    } message: {
      Text(state.message ?? "")
    }
  }
  func icon(_ page: Page) -> String {
    switch page {
    case .cut: return "scissors"
    case .batch: return "square.stack.3d.up"
    case .history: return "clock.arrow.circlepath"
    case .settings: return "gearshape"
    }
  }
  func english(_ page: Page) -> String {
    switch page {
    case .cut: return "Auto Cut"
    case .batch: return "Batch Tasks"
    case .history: return "History"
    case .settings: return "Settings"
    }
  }
}

struct CutView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    Group {
      if state.flow == .review && state.mode == .custom {
        CustomWorkspace()
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            HStack {
              VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.largeTitle.bold())
                Text(subtitle).foregroundStyle(.secondary)
              }
              Spacer()
              if state.flow != .idle {
                Button(state.english ? "New task" : "新建任务") { state.reset() }.disabled(state.busy)
              }
            }.padding([.horizontal, .top], 28)
            if state.flow != .calibration, state.source != nil {
              VideoMonitor(playback: state.playback).frame(maxWidth: .infinity).frame(height: 320)
                .padding(.horizontal, 28)
            }
            Group {
              switch state.flow {
              case .idle:
                if state.busy {
                  VStack(spacing: 16) {
                    ProgressView()
                    Text(state.stage)
                    Button("取消") { state.cancel() }
                  }.frame(maxWidth: .infinity, minHeight: 260)
                } else {
                  VStack(spacing: 16) {
                    DropCard(action: state.openVideo, accept: state.acceptVideos)
                    if !state.batch.isEmpty { Button("继续批量任务") { state.page = .batch } }
                  }
                }
              case .calibration: CalibrationView()
              case .analyzing, .exporting: ProgressCard()
              case .review: ReviewView()
              case .complete: CompleteView()
              }
            }.padding([.horizontal, .bottom], 28)
          }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
      }
    }
  }
  var title: String {
    switch state.flow {
    case .calibration: return state.english ? "Table calibration" : "球台标定"
    case .review: return state.english ? "Choose clips" : "选择剪辑内容"
    case .complete: return state.english ? "Export complete" : "成功导出"
    default: return state.english ? "Auto Cut" : "自动剪辑"
    }
  }
  var subtitle: String {
    state.source?.name
      ?? (state.english ? "Analyze and cut table-tennis video locally." : "在本机分析乒乓球视频并完成剪辑")
  }
}

struct DropCard: View {
  var action: () -> Void
  var accept: ([URL]) -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 14) {
        Image(systemName: "video.badge.plus").font(.system(size: 44))
        Text("选择乒乓球视频").font(.title2.bold())
        Text("支持 MP4、MOV 等 FFmpeg 可解码格式").foregroundStyle(.secondary)
      }.frame(maxWidth: .infinity, minHeight: 260).background(.background).clipShape(
        RoundedRectangle(cornerRadius: 16)
      ).overlay(
        RoundedRectangle(cornerRadius: 16).strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8]))
          .foregroundStyle(.quaternary))
    }.buttonStyle(.plain).dropDestination(for: URL.self) { urls, _ in
      accept(urls)
      return !urls.isEmpty
    }
  }
}

struct ProgressCard: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    VStack(spacing: 14) {
      ProgressView(value: state.progress)
      Text(state.stage)
      Button("取消", role: .destructive) {
        state.cancel()
        state.flow = state.result == nil ? .calibration : .review
      }
    }.card()
  }
}

struct ReviewView: View {
  @EnvironmentObject var state: AppState
  @State private var outputs = ExportOutputs()
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Picker("模式", selection: $state.mode) {
        Text("全部剪辑").tag(CutMode.all)
        Text("精彩回合").tag(CutMode.highlight)
        Text("自定义").tag(CutMode.custom)
      }.pickerStyle(.segmented)
      if state.mode == .highlight {
        HStack {
          Text("仅保留大于 \(state.highlightThreshold) 板的回合")
          Picker("大于", selection: $state.highlightThreshold) {
            Text("3 板").tag(3)
            Text("5 板").tag(5)
            Text("7 板").tag(7)
          }.labelsHidden().frame(width: 130)
        }
      }
      if state.mode == .custom, let source = state.source {
        ClipTimeline(
          clips: $state.custom, video: source, bounces: state.result?.bounceTimes ?? [],
          add: state.addManualClip, playback: state.playback
        ).frame(height: 210)
        Toggle("合并导出", isOn: $outputs.combined)
        Toggle("分段导出", isOn: $outputs.rallyVideos).disabled(outputs.combined)
        Toggle("Premiere XML", isOn: $outputs.xml).disabled(outputs.combined)
      }
      Text(
        "识别到 \(state.result?.rallies.count ?? 0) 个回合、\(state.result?.bounceTimes.count ?? 0) 次弹跳"
      ).foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("开始剪辑") { state.export(outputs: state.mode == .custom ? outputs : ExportOutputs()) }
          .buttonStyle(.borderedProminent)
      }
    }.card().onChange(of: outputs.combined) {
      if outputs.combined {
        outputs.rallyVideos = false
        outputs.xml = false
      }
    }
  }
}

struct CompleteView: View {
  @EnvironmentObject var state: AppState
  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 50)).foregroundStyle(.green)
      Text("成功导出").font(.title2.bold())
      Button("继续剪辑") { state.flow = .review }
      if let folder = state.destination {
        Text(folder.path).textSelection(.enabled)
        Button("在 Finder 中显示") { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
      }
    }.card()
  }
}

extension View {
  func card() -> some View {
    self.padding(20).background(.background).clipShape(RoundedRectangle(cornerRadius: 14)).shadow(
      color: .black.opacity(0.04), radius: 12, y: 4)
  }
}
