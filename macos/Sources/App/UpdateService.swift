import Foundation
import Sparkle

@MainActor final class UpdateService: NSObject, ObservableObject, SPUUpdaterDelegate {
  @Published var status = "更新尚未配置"
  @Published var configured = false
  private var controller: SPUStandardUpdaterController?
  private let feed: String?
  override init() {
    let value = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String
    if let value, let url = URL(string: value), ["https", "http"].contains(url.scheme ?? ""),
      url.scheme == "https" || ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
    {
      feed = value
    } else {
      feed = nil
    }
    super.init()
    guard feed != nil,
      let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
      Data(base64Encoded: key)?.count == 32
    else { return }
    let controller = SPUStandardUpdaterController(
      startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    controller.updater.clearFeedURLFromUserDefaults()
    self.controller = controller
    do {
      try controller.updater.start()
      configured = true
      status = "可检查更新"
    } catch { status = "更新初始化失败：" + error.localizedDescription }
  }
  func check() {
    guard configured else { return }
    status = "正在检查更新"
    controller?.checkForUpdates(nil)
  }
  func feedURLString(for updater: SPUUpdater) -> String? { feed }
  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    status = "发现新版本：" + item.displayVersionString
  }
  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    status = "更新失败：" + error.localizedDescription
  }
  func updater(
    _ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?
  ) {
    if let error { status = "更新检查结束：" + error.localizedDescription }
  }
}
