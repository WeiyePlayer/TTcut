import SwiftUI
import TTcutCore

struct CustomWorkspace: View {
  @EnvironmentObject var state: AppState
  @State private var outputs = ExportOutputs()
  @State private var showingExport = false
  var body: some View {
    VStack(spacing: 14) {
      HStack {
        Button {
          state.mode = .all
        } label: {
          Label("返回", systemImage: "chevron.left")
        }
        Text(state.sourceName ?? "").font(.headline).lineLimit(1)
        Spacer()
        Text("\(state.custom.filter(\.selected).count) / \(state.custom.count) 回合").foregroundStyle(
          .secondary).accessibilityIdentifier("customSelectionCount")
      }
      HStack(alignment: .top, spacing: 18) {
        VStack(alignment: .leading) {
          HStack {
            Text("回合列表").font(.headline)
            Spacer()
            Button(state.custom.allSatisfy(\.selected) ? "取消全选" : "全选") {
              state.setAllCustomSelected(!state.custom.allSatisfy(\.selected))
            }.disabled(state.custom.isEmpty).accessibilityIdentifier("toggleAllRallies")
          }.padding(.horizontal, 12)
          List {
            ForEach(state.custom) { clip in
              HStack(alignment: .top) {
                Toggle(
                  "",
                  isOn: Binding(
                    get: { state.custom.first(where: { $0.id == clip.id })?.selected ?? false },
                    set: { selected in
                      guard let video = state.source else { return }
                      state.custom = Clips.setSelected(
                        state.custom, id: clip.id, selected: selected, duration: video.duration,
                        fps: video.fps)
                    })
                ).labelsHidden().toggleStyle(.checkbox)
                VStack(alignment: .leading, spacing: 5) {
                  HStack {
                    Text("回合 \(clip.index)").font(.headline)
                    Spacer()
                    if clip.isManual {
                      Text("手动回合").font(.caption).foregroundStyle(.secondary)
                    } else {
                      Text("\(clip.bounceCount ?? 0) 板").font(.caption).foregroundStyle(.secondary)
                    }
                  }
                  Text(String(format: "%.2f – %.2f", clip.start, clip.end)).font(
                    .caption.monospacedDigit()
                  ).foregroundStyle(.secondary)
                }.contentShape(Rectangle()).onTapGesture { state.playback.seek(clip.start) }
              }.padding(.vertical, 5)
            }
          }.listStyle(.inset)
        }.frame(width: 230)
        VStack(spacing: 14) {
          VideoMonitor(playback: state.playback).frame(minHeight: 200, maxHeight: .infinity)
          if let video = state.source {
            ClipTimeline(
              clips: $state.custom, video: video, bounces: state.result?.bounceTimes ?? [],
              add: state.addManualClip, playback: state.playback
            ).frame(height: 200)
          }
          HStack {
            if state.source?.variableFrameRate == true {
              Text("XML 剪辑点按标称帧率量化。").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("开始剪辑") { showingExport = true }.buttonStyle(.borderedProminent).disabled(
              !state.custom.contains(where: \.selected)
            )
            .popover(isPresented: $showingExport) {
              VStack(alignment: .leading, spacing: 14) {
                Text("自定义导出选项").font(.headline)
                Toggle("合并导出", isOn: $outputs.combined)
                Toggle("分段导出", isOn: $outputs.rallyVideos).disabled(outputs.combined)
                Toggle("Premiere XML", isOn: $outputs.xml).disabled(outputs.combined)
                Button("导出") {
                  showingExport = false
                  state.export(outputs: outputs)
                }.buttonStyle(.borderedProminent).disabled(
                  !outputs.combined && !outputs.rallyVideos && !outputs.xml)
              }.padding(20).frame(width: 250).onChange(of: outputs.combined) {
                if outputs.combined {
                  outputs.rallyVideos = false
                  outputs.xml = false
                }
              }
            }
          }
        }
      }
    }.padding(20)
  }
}
