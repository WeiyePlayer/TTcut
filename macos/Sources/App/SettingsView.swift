import SwiftUI
import TTcutCore

struct SettingsView: View {
  @EnvironmentObject var state: AppState
  @StateObject private var updates = UpdateService()
  @State private var showingContact = false
  var body: some View {
    Form {
      Section("界面") {
        Picker("语言", selection: $state.settings.language) {
          Text("简体中文").tag("zh-CN")
          Text("English").tag("en")
        }
      }
      Section("球台标定") {
        Toggle("自动标定", isOn: $state.settings.automaticCalibration)
        Text("批量任务先自动识别；失败项目可手动补充。").font(.caption).foregroundStyle(.secondary)
      }
      Section("分析") {
        Picker("分析模式", selection: $state.settings.analysisMode) {
          Text("全视频分析").tag(AnalysisMode.full)
          Text("两阶段分析").tag(AnalysisMode.twoStage)
        }
        Toggle("VFR 转换为固定帧率处理媒体", isOn: $state.settings.normalizeVFR)
        Picker("回合前保留", selection: $state.settings.preRoll) {
          Text("1.5 秒").tag(1.5)
          Text("2.5 秒").tag(2.5)
          Text("5 秒").tag(5.0)
        }
        Picker("回合后保留", selection: $state.settings.postRoll) {
          Text("0.5 秒").tag(0.5)
          Text("1 秒").tag(1.0)
          Text("2 秒").tag(2.0)
          Text("4 秒").tag(4.0)
        }
      }.disabled(state.busy)
      Section("更新") {
        Text(LocalizedStringKey(updates.status)).foregroundStyle(.secondary)
        Button("检查更新") { updates.check() }.disabled(!updates.configured || state.busy)
      }
      Section("关于") {
        Text("TTcut 1.2.10 · macOS 15+ · Apple Silicon")
        HStack {
          Link("官方网站", destination: URL(string: "https://ttcut.vercel.app/")!)
          Link("GitHub", destination: URL(string: "https://github.com/WeiyePlayer/TTcut")!)
          Button("联系作者") { showingContact = true }.popover(isPresented: $showingContact) {
            VStack {
              BundleImage(name: "contact-author-qr").frame(width: 220, height: 220)
              Text("微信扫码联系作者")
            }.padding()
          }
          Link("打赏作者", destination: URL(string: "https://ifdian.net/a/weiye")!)
        }
        Button("打开日志文件夹") {
          Task {
            let root = await state.store.root.appendingPathComponent("logs", isDirectory: true)
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            NSWorkspace.shared.open(root)
          }
        }
      }
    }.formStyle(.grouped).padding(12).onChange(of: state.settings) { state.saveSettings() }
  }
}
