import Foundation
import TTcutCore

public struct ExportColorPlan: Sendable {
  public let source: VideoInfo
  public let target: VideoInfo
  public let toneMapTransfer: String?

  public init(source: VideoInfo) throws {
    self.source = source
    guard source.hdr == .hdr10Plus || source.hdr == .dolbyVision else {
      try source.validateHDRExport()
      target = source
      toneMapTransfer = nil
      return
    }
    let transfer: String?
    if source.hdr == .hdr10Plus && source.colorTransfer == "smpte2084" {
      transfer = "smpte2084"
    } else if source.hdr == .dolbyVision, let dv = source.dolbyVision,
      dv.profile == 8, dv.baseLayerPresent {
      transfer = dv.signalCompatibilityID == 1 ? "smpte2084"
        : dv.signalCompatibilityID == 4 ? "arib-std-b67" : nil
    } else {
      transfer = nil
    }
    guard let transfer else {
      throw TTError("DYNAMIC_HDR_UNSUPPORTED", "无法确认兼容基础层，请先将源视频转换为 SDR BT.709 后重试")
    }
    var supported = source
    supported.hdr = .sdr
    try supported.validateHDRExport()
    toneMapTransfer = transfer
    var output = source
    output.videoCodec = "h264"
    output.pixelFormat = "yuv420p"
    output.bitDepth = 8
    output.chroma = "420"
    output.hdr = .sdr
    output.dolbyVision = nil
    output.colorRange = "tv"
    output.colorPrimaries = "bt709"
    output.colorTransfer = "bt709"
    output.colorSpace = "bt709"
    output.masteringDisplay = nil
    output.maxCLL = nil
    target = output
  }

  public var filters: [String] {
    guard let toneMapTransfer else { return [] }
    let range = ["pc", "full", "jpeg"].contains(source.colorRange ?? "") ? "full" : "limited"
    return [
      "zscale=pin=bt2020:tin=\(toneMapTransfer):min=bt2020nc:rin=\(range):t=linear:npl=100",
      "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=2",
      "zscale=t=bt709:m=bt709:r=limited", "format=yuv420p",
    ] + ["MASTERING_DISPLAY_METADATA", "CONTENT_LIGHT_LEVEL", "DYNAMIC_HDR_PLUS", "DOVI_RPU_BUFFER", "DOVI_METADATA"].map {
      "sidedata=mode=delete:type=\($0)"
    }
  }
}
