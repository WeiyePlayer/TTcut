import AVKit
import SwiftUI
import TTcutCore
import TTcutMedia

@MainActor final class PlaybackController: ObservableObject {
  let player = AVPlayer()
  @Published var time = 0.0
  @Published var preparing = false
  @Published var progress = 0.0
  @Published var error: String?
  @Published var usingProxy = false
  private var observation: NSKeyValueObservation?
  private var timer: Any?
  private var task: Task<Void, Never>?
  private var generation = UUID()
  init() {
    timer = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.05, preferredTimescale: 600), queue: .main
    ) { [weak self] value in
      Task { @MainActor in if value.seconds.isFinite { self?.time = max(0, value.seconds) } }
    }
  }
  deinit {
    task?.cancel()
    if let timer { player.removeTimeObserver(timer) }
  }
  func load(video: VideoInfo, paths: RuntimePaths) {
    task?.cancel()
    observation = nil
    generation = UUID()
    let current = generation
    player.pause()
    time = 0
    error = nil
    usingProxy = false
    preparing = false
    let item = AVPlayerItem(url: video.url)
    player.replaceCurrentItem(with: item)
    observation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
      if item.status == .failed {
        Task { @MainActor in
          guard let self, self.generation == current else { return }
          self.fallback(video: video, paths: paths, generation: current)
        }
      }
    }
    task = Task {
      let playable = (try? await AVURLAsset(url: video.url).load(.isPlayable)) ?? false
      guard !Task.isCancelled, generation == current else { return }
      if !playable { fallback(video: video, paths: paths, generation: current) }
    }
  }
  private func fallback(video: VideoInfo, paths: RuntimePaths, generation current: UUID) {
    guard !preparing, !usingProxy else { return }
    preparing = true
    observation = nil
    task = Task {
      defer { if generation == current { preparing = false } }
      do {
        let proxy = try await MediaPreview.make(video: video, paths: paths) { [weak self] value in
          Task { @MainActor in self?.progress = value }
        }
        guard !Task.isCancelled, generation == current else { return }
        usingProxy = true
        player.replaceCurrentItem(with: AVPlayerItem(url: proxy))
      } catch is CancellationError {} catch {
        if generation == current { self.error = error.localizedDescription }
      }
    }
  }
  func seek(_ seconds: Double) {
    guard seconds.isFinite else { return }
    time = max(0, seconds)
    player.seek(
      to: CMTime(seconds: time, preferredTimescale: 60000), toleranceBefore: .zero,
      toleranceAfter: .zero)
  }
  func toggle() { player.rate == 0 ? player.play() : player.pause() }
  func stop() {
    task?.cancel()
    generation = UUID()
    observation = nil
    player.pause()
    player.replaceCurrentItem(with: nil)
    time = 0
    preparing = false
  }
}

struct VideoMonitor: View {
  @ObservedObject var playback: PlaybackController
  var body: some View {
    ZStack {
      PlayerPanel(player: playback.player)
      if playback.preparing {
        VStack(spacing: 12) {
          ProgressView(value: playback.progress)
          Text("正在准备兼容预览")
        }.padding(24).background(.regularMaterial).clipShape(RoundedRectangle(cornerRadius: 12))
          .frame(width: 320)
      }
      if let error = playback.error {
        Text(error).foregroundStyle(.white).padding().background(.black.opacity(0.8))
      }
    }.background(.black).clipShape(RoundedRectangle(cornerRadius: 12))
  }
}
struct PlayerPanel: NSViewRepresentable {
  var player: AVPlayer
  func makeNSView(context: Context) -> AVPlayerView {
    let view = AVPlayerView()
    view.player = player
    view.controlsStyle = .floating
    return view
  }
  func updateNSView(_ view: AVPlayerView, context: Context) {
    if view.player !== player { view.player = player }
  }
}
