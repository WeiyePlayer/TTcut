import SwiftUI
import TTcutCore

struct CalibrationView: View {
  @EnvironmentObject var state: AppState
  @State private var zoom = 1.0
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("按左上、右上、右下、左下顺序选择球桌四角。").foregroundStyle(.secondary)
        Spacer()
        Text("\(state.calibration?.points.count ?? 0) / 4").monospacedDigit()
        Button {
          zoom = max(1, zoom - 0.25)
        } label: {
          Image(systemName: "minus.magnifyingglass")
        }
        Button {
          zoom = min(4, zoom + 0.25)
        } label: {
          Image(systemName: "plus.magnifyingglass")
        }
        Button("重置") {
          state.calibration = nil
          zoom = 1
        }
      }
      if let source = state.source {
        GeometryReader { proxy in
          let ratio = Double(source.width) / Double(source.height)
          let width = min(proxy.size.width, proxy.size.height * ratio)
          let height = width / ratio
          ScrollView([.horizontal, .vertical]) {
            CalibrationSurface(
              calibration: $state.calibration, image: state.previewImage, source: source
            )
            .frame(width: width * zoom, height: height * zoom)
            .padding(.horizontal, max(0, (proxy.size.width - width * zoom) / 2))
            .padding(.vertical, max(0, (proxy.size.height - height * zoom) / 2))
          }.background(.black).clipShape(RoundedRectangle(cornerRadius: 12))
        }.frame(minHeight: 260, maxHeight: 420)
      }
      if state.busy {
        ProgressView(value: state.progress)
        Text(state.stage).foregroundStyle(.secondary)
      }
      HStack {
        Button("重新自动标定") { state.retryCalibration() }.disabled(state.busy)
        Spacer()
        Button("开始分析") { state.analyze() }.buttonStyle(.borderedProminent)
          .disabled(state.calibration?.points.count != 4 || state.busy)
      }
    }.card()
  }
}

private struct CalibrationSurface: View {
  @Binding var calibration: Calibration?
  var image: NSImage?
  var source: VideoInfo
  var body: some View {
    GeometryReader { proxy in
      let points = calibration?.points ?? []
      ZStack(alignment: .topLeading) {
        if let image {
          Image(nsImage: image).resizable().interpolation(.high).frame(
            width: proxy.size.width, height: proxy.size.height)
        } else {
          Color.black
        }
        Color.clear.contentShape(Rectangle()).onTapGesture { location in
          guard points.count < 4 else { return }
          let point = sourcePoint(location, in: proxy.size)
          calibration = Calibration(
            width: source.width, height: source.height, points: points + [point])
        }
        if points.count >= 2 {
          Path { path in
            path.move(to: displayPoint(points[0], in: proxy.size))
            points.dropFirst().forEach { path.addLine(to: displayPoint($0, in: proxy.size)) }
            if points.count == 4 { path.closeSubpath() }
          }.stroke(.cyan, lineWidth: 2).allowsHitTesting(false)
        }
        ForEach(points.indices, id: \.self) { index in
          let point = displayPoint(points[index], in: proxy.size)
          ZStack {
            Circle().fill(.white).overlay(Circle().stroke(.blue, lineWidth: 3)).frame(
              width: 24, height: 24)
            Text("\(index+1)").font(.caption.bold()).foregroundStyle(.black)
          }.position(point).accessibilityLabel("球桌角 \(index+1)")
            .gesture(
              DragGesture(coordinateSpace: .named("calibration")).onChanged { value in
                var next = points
                next[index] = sourcePoint(value.location, in: proxy.size)
                calibration = Calibration(width: source.width, height: source.height, points: next)
              })
        }
      }.coordinateSpace(name: "calibration").accessibilityElement(children: .contain)
        .accessibilityIdentifier("calibrationSurface")
    }
  }
  func sourcePoint(_ point: CGPoint, in size: CGSize) -> Point {
    Point(
      min(Double(source.width - 1), max(0, point.x / size.width * Double(source.width))),
      min(Double(source.height - 1), max(0, point.y / size.height * Double(source.height))))
  }
  func displayPoint(_ point: Point, in size: CGSize) -> CGPoint {
    CGPoint(
      x: point.x / Double(source.width) * size.width,
      y: point.y / Double(source.height) * size.height)
  }
}
