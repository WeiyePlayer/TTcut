#if DEBUG
  import AppKit
  import Sparkle

  /// Automatic replies exist only in Debug, for isolated local update test copies.
  @MainActor final class UpdateTestDriver: NSObject, SPUUserDriver {
    static var retained: UpdateTestDriver?
    var updater: SPUUpdater?
    let log: URL
    init(log: URL) {
      self.log = log
      super.init()
    }
    static func startIfConfigured() {
      guard Bundle.main.bundleIdentifier?.hasPrefix("com.weiyeplayer.ttcut.updatetest.") == true,
        Bundle.main.object(forInfoDictionaryKey: "TTcutUpdateTest") as? Bool == true,
        let path = Bundle.main.object(forInfoDictionaryKey: "TTcutUpdateTestLog") as? String,
        let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
        let url = URL(string: feed), url.host == "127.0.0.1"
      else { return }
      let driver = UpdateTestDriver(log: URL(fileURLWithPath: path))
      retained = driver
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
      driver.event("launched-" + version)
      if version == "2" {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
        return
      }
      let updater = SPUUpdater(
        hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: nil)
      driver.updater = updater
      do {
        try updater.start()
        updater.checkForUpdates()
      } catch { driver.event("error: " + error.localizedDescription) }
    }
    func event(_ text: String) {
      let data = Data((text + "\n").utf8)
      if !FileManager.default.fileExists(atPath: log.path) {
        FileManager.default.createFile(atPath: log.path, contents: nil)
      }
      if let handle = try? FileHandle(forWritingTo: log) {
        try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
        try? handle.close()
      }
    }
    func show(
      _ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) { reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false)) }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { event("checking") }
    func showUpdateFound(
      with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
      reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
      event("found-" + appcastItem.versionString)
      reply(.install)
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) { event("notes-error") }
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
      event("not-found: " + error.localizedDescription)
      acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
      event("error: " + String(describing: error))
      acknowledgement()
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) { event("downloading") }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
    func showDownloadDidReceiveData(ofLength length: UInt64) {}
    func showDownloadDidStartExtractingUpdate() { event("extracting") }
    func showExtractionReceivedProgress(_ progress: Double) {}
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
      event("ready-to-install")
      reply(.install)
    }
    func showInstallingUpdate(
      withApplicationTerminated applicationTerminated: Bool,
      retryTerminatingApplication: @escaping () -> Void
    ) { event("installing") }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void)
    {
      event("installed")
      acknowledgement()
    }
    func dismissUpdateInstallation() { event("dismissed") }
  }
#endif
