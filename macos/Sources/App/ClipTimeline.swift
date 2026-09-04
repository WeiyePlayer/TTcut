import SwiftUI
import TTcutCore

struct ClipTimeline: View {
  @Binding var clips: [CustomClip]
  var video: VideoInfo
  var bounces: [Double]
  var add: (Double) -> Void
  @ObservedObject var playback: PlaybackController
  @State private var zoom = 1.0
  private var playhead: Double { playback.time }
  @State private var focused: String?
  var body: some View {
    VStack(spacing: 10) {
      HStack {
        Text("自定义剪辑时间轴").font(.headline)
        Button {
          playback.toggle()
        } label: {
          Image(systemName: "playpause.fill")
        }.keyboardShortcut(.space, modifiers: [])
        Spacer()
        Button {
          zoom = max(1, zoom / 1.5)
        } label: {
          Image(systemName: "minus.magnifyingglass")
        }
        Button {
          zoom = min(64, zoom * 1.5)
        } label: {
          Image(systemName: "plus.magnifyingglass")
        }
        Button("增加回合") { add(playhead) }
        Button("删除回合", role: .destructive) {
          if let focused {
            clips = Clips.reindex(clips.filter { $0.id != focused })
            self.focused = nil
          }
        }.disabled(focused == nil)
      }
      GeometryReader { proxy in
        ScrollView(.horizontal) {
          let width = max(proxy.size.width, proxy.size.width * zoom)
          ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 8).fill(.black.opacity(0.88))
            Color.clear.contentShape(Rectangle()).onTapGesture { point in
              playback.seek(min(video.duration, max(0, point.x / width * video.duration)))
            }
            ForEach(0..<11, id: \.self) { tick in
              let fraction = Double(tick) / 10
              Text(timestamp(fraction * video.duration)).font(.caption2.monospacedDigit())
                .foregroundStyle(.gray).frame(width: 70)
                .offset(x: min(width - 70, max(0, fraction * width - 35)), y: 5)
            }
            ForEach(clips) { clip in
              let x = clip.start / video.duration * width
              let clipWidth = max(3, (clip.end - clip.start) / video.duration * width)
              ZStack {
                RoundedRectangle(cornerRadius: 5).fill(
                  clip.selected ? Color.blue : Color.gray.opacity(0.6)
                )
                .overlay(
                  RoundedRectangle(cornerRadius: 5).stroke(
                    focused == clip.id ? Color.white : Color.clear, lineWidth: 2))
                Text("\(clip.index)").font(.caption2).foregroundStyle(.white)
              }.frame(width: clipWidth, height: 50).offset(x: x, y: 28)
                .onTapGesture {
                  focused = clip.id
                  playback.seek(clip.start)
                }
                .onTapGesture(count: 2) { select(clip, !clip.selected) }
              edge(clip, start: true, width: width).offset(x: x - 4, y: 28)
              edge(clip, start: false, width: width).offset(x: x + clipWidth - 4, y: 28)
            }
            ForEach(Array(bounces.enumerated()), id: \.offset) { _, time in
              Rectangle().fill(.orange).frame(width: 1, height: 10).offset(
                x: time / video.duration * width, y: 83
              ).allowsHitTesting(false)
            }
            Rectangle().fill(.white).frame(width: 2, height: 76).offset(
              x: playhead / video.duration * width, y: 20
            ).allowsHitTesting(false)
          }.coordinateSpace(name: "timeline").frame(width: width, height: 102)
        }
      }.frame(height: 110)
      if let clip = clips.first(where: { $0.id == focused }) {
        HStack {
          Toggle(
            "保留回合",
            isOn: Binding(
              get: { clips.first(where: { $0.id == clip.id })?.selected ?? false },
              set: { select(clip, $0) }))
          Text("\(clip.index) · \(clip.bounceCount.map(String.init) ?? "—") 板")
          Spacer()
          Text("开始")
          TextField(
            "开始",
            value: Binding(
              get: { clips.first(where: { $0.id == clip.id })?.start ?? 0 },
              set: { resize(clip, start: true, time: $0) }),
            format: .number.precision(.fractionLength(3))
          ).frame(width: 80)
          Text("结束")
          TextField(
            "结束",
            value: Binding(
              get: { clips.first(where: { $0.id == clip.id })?.end ?? 0 },
              set: { resize(clip, start: false, time: $0) }),
            format: .number.precision(.fractionLength(3))
          ).frame(width: 80)
        }.font(.caption)
      } else {
        Text("单击片段查看，双击片段选择或排除；拖动两端调整范围。").font(.caption).foregroundStyle(.secondary)
      }
    }
  }
  func edge(_ clip: CustomClip, start: Bool, width: Double) -> some View {
    RoundedRectangle(cornerRadius: 2).fill(.white.opacity(0.8)).frame(width: 8, height: 50)
      .contentShape(Rectangle())
      .gesture(
        DragGesture(coordinateSpace: .named("timeline")).onChanged { gesture in
          focused = clip.id
          resize(clip, start: start, time: gesture.location.x / width * video.duration)
        })
  }
  func select(_ clip: CustomClip, _ value: Bool) {
    clips = Clips.setSelected(
      clips, id: clip.id, selected: value, duration: video.duration, fps: video.fps)
  }
  func resize(_ clip: CustomClip, start: Bool, time: Double) {
    guard time.isFinite else { return }
    clips = Clips.resize(
      clips, id: clip.id, startEdge: start, time: time, duration: video.duration, fps: video.fps,
      bounceTimes: bounces)
  }
  func timestamp(_ time: Double) -> String {
    if video.duration < 60 {
      return String(format: "%02d:%05.2f", Int(time) / 60, time.truncatingRemainder(dividingBy: 60))
    }
    return String(format: "%02d:%02d", Int(time) / 60, Int(time) % 60)
  }
}
