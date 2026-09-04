import SwiftUI

@main struct TTcutApp: App {
  @StateObject private var state = AppState()
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(state).environment(
        \.locale, Locale(identifier: state.settings.language)
      ).preferredColorScheme(.light).frame(minWidth: 1040, minHeight: 680)
    }
    .windowStyle(.hiddenTitleBar)
    .commands {
      CommandGroup(after: .newItem) {
        Button(state.english ? "Open Video…" : "打开视频…") { state.openVideo() }.keyboardShortcut("o")
      }
    }
  }
}
