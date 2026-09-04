import SwiftUI
import TTcutCore

struct ClipTimeline: View {
  @Binding var clips: [CustomClip]
  var video: VideoInfo
  var bounces: [Double]
  var add: (Double) -> Void
  @ObservedObject var playback: PlaybackController
  @State private var zoom = 1.0
  @State private var position = ScrollPosition(x: 0)
  @State private var scrollOffset = 0.0
  @State private var viewportWidth = 1.0
  @State private var pendingOffset: Double?
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
        Button("增加回合") { add(playhead) }
        Button("删除回合", role: .destructive) {
          if let focused {
            clips = Clips.reindex(clips.filter { $0.id != focused })
            self.focused = nil
          }
        }.disabled(focused == nil)
      }
      HStack(spacing: 10) {
        Text("视频轨缩放").font(.caption).foregroundStyle(.secondary)
        Button { setZoom(zoom / 2) } label: {
          Image(systemName: "minus.magnifyingglass")
        }.disabled(zoom <= 1).help("缩小时间轴").accessibilityIdentifier("timeline.zoomOut")
        Slider(
          value: Binding(get: { log2(zoom) }, set: { setZoom(pow(2, $0)) }), in: 0...6
        ).frame(width: 140).accessibilityLabel("视频轨缩放")
          .accessibilityIdentifier("timeline.zoomSlider")
        Button { setZoom(zoom * 2) } label: {
          Image(systemName: "plus.magnifyingglass")
        }.disabled(zoom >= 64).help("放大时间轴").accessibilityIdentifier("timeline.zoomIn")
        Text(String(format: "%.0f%%", zoom * 100)).font(.caption.monospacedDigit())
          .frame(width: 48, alignment: .trailing).accessibilityIdentifier("timeline.zoomValue")
        Button("适应全部") { setZoom(1) }.accessibilityIdentifier("timeline.fitAll")
        Spacer()
      }
      GeometryReader { proxy in
        ScrollView(.horizontal) {
          let width = max(proxy.size.width, proxy.size.width * zoom)
          ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .underPageBackgroundColor))
            Color.clear.contentShape(Rectangle()).onTapGesture { point in
              playback.seek(min(video.duration, max(0, point.x / width * video.duration)))
            }
            ForEach(tickTimes(width: width), id: \.self) { time in
              Text(timestamp(time)).font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary).frame(width: 76)
                .offset(x: min(width - 76, max(0, time / video.duration * width - 38)), y: 5)
                .allowsHitTesting(false)
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
                    focused == clip.id ? Color.primary : Color.clear, lineWidth: 2))
                if clipWidth >= 18 {
                  Text("\(clip.index)").font(.caption2).foregroundStyle(.white).lineLimit(1)
                }
              }.frame(width: clipWidth, height: 50).offset(x: x, y: 28)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("回合 \(clip.index)")
                .accessibilityIdentifier("timeline.clip.\(clip.id)")
                .onTapGesture {
                  focused = clip.id
                  playback.seek(clip.start)
                }
                .onTapGesture(count: 2) { select(clip, !clip.selected) }
              if clip.selected, clipWidth >= 18 {
                edge(clip, start: true, width: width).offset(x: x, y: 28)
                edge(clip, start: false, width: width).offset(x: x + clipWidth - 8, y: 28)
              }
            }
            ForEach(Array(bounces.enumerated()), id: \.offset) { _, time in
              Rectangle().fill(.orange).frame(width: 1, height: 10).offset(
                x: time / video.duration * width, y: 83
              ).allowsHitTesting(false)
            }
            Rectangle().fill(.primary).frame(width: 2, height: 76).offset(
              x: playhead / video.duration * width, y: 20
            ).allowsHitTesting(false)
          }.frame(width: width, height: 102).coordinateSpace(name: "timeline")
            .accessibilityIdentifier("timeline.track")
        }
        .scrollPosition($position)
        .scrollIndicators(.visible)
        .onScrollGeometryChange(for: Double.self) { max(0, $0.contentOffset.x) } action: { _, offset in
          scrollOffset = offset
        }
        .onScrollGeometryChange(for: CGSize.self) {
          CGSize(width: $0.contentSize.width, height: $0.containerSize.width)
        } action: { _, size in
          viewportWidth = max(1, size.height)
          // Apply after the wider track is laid out; scrolling before that clamps to the old width.
          if let pendingOffset {
            position.scrollTo(x: min(max(0, size.width - viewportWidth), pendingOffset))
            self.pendingOffset = nil
          }
        }
        .onChange(of: playback.time) { _, time in
          let x = time / video.duration * viewportWidth * zoom
          if x < scrollOffset || x > scrollOffset + viewportWidth {
            position.scrollTo(x: max(0, x - viewportWidth / 2))
          }
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
  private func setZoom(_ value: Double) {
    let next = min(64, max(1, value))
    guard next != zoom else {
      if next == 1 { position.scrollTo(x: 0) }
      return
    }
    let headX = playhead / video.duration * viewportWidth * zoom - scrollOffset
    let anchorX = (0...viewportWidth).contains(headX) ? headX : viewportWidth / 2
    pendingOffset = max(0, (scrollOffset + anchorX) * next / zoom - anchorX)
    zoom = next
  }
  private func tickTimes(width: Double) -> [Double] {
    let minimum = max(1 / video.fps, video.duration / width * 90)
    let magnitude = pow(10, floor(log10(minimum)))
    let step = [1.0, 2, 5, 10].map { $0 * magnitude }.first { $0 >= minimum } ?? minimum
    let start = max(0, floor(scrollOffset / width * video.duration / step) - 1) * step
    let end = min(video.duration, (scrollOffset + viewportWidth) / width * video.duration + step)
    return Array(stride(from: start, through: end, by: step))
  }
  func edge(_ clip: CustomClip, start: Bool, width: Double) -> some View {
    RoundedRectangle(cornerRadius: 2).fill(.white.opacity(0.8)).frame(width: 8, height: 50)
      .contentShape(Rectangle())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(start ? "调整开始时间" : "调整结束时间")
      .accessibilityIdentifier("timeline.\(start ? "start" : "end").\(clip.id)")
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
    if video.duration / zoom < 60 {
      return String(format: "%02d:%05.2f", Int(time) / 60, time.truncatingRemainder(dividingBy: 60))
    }
    return String(format: "%02d:%02d", Int(time) / 60, Int(time) % 60)
  }
}
