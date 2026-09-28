// Windows-only libmpv host. Video stays on the GPU; stdout is a bounded JSON-lines control channel.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <mpv/client.h>
#include "json.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

using json = nlohmann::json;
static std::mutex outputMutex, inputMutex;
static std::deque<json> input;
static std::atomic<bool> inputClosed{false};
static HWND host = nullptr;
static mpv_handle* player = nullptr;
static uint64_t sequence = 0, samples = 0;
static bool ready = false, seeking = false;
static bool desiredPaused = true;
static double lastPts = -1;
static json overlay;
static HWND editor = nullptr;
static HWND editorSurface = nullptr;
static HFONT editorFont = nullptr;
static WNDPROC editorProc = nullptr;
static std::string editField, editClipId;
static bool editComposing = false, normalizingScore = false;
#define MPV_API(X) X(mpv_create) X(mpv_initialize) X(mpv_set_option_string) X(mpv_set_property_string) X(mpv_get_property) X(mpv_get_property_string) X(mpv_free) X(mpv_command) X(mpv_command_async) X(mpv_wait_event) X(mpv_terminate_destroy) X(mpv_error_string) X(mpv_request_log_messages)
#define DECLARE(name) static decltype(&name) api_##name;
MPV_API(DECLARE)

static void emit(json value) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << value.dump() << '\n' << std::flush;
}
static void error(const std::string& message) { emit({{"type", "error"}, {"message", message}}); }
static double number(const char* name, double fallback = 0) {
  double value; return api_mpv_get_property(player, name, MPV_FORMAT_DOUBLE, &value) >= 0 && std::isfinite(value) ? value : fallback;
}
static bool flag(const char* name) {
  int value = 0; api_mpv_get_property(player, name, MPV_FORMAT_FLAG, &value); return value != 0;
}
static std::string textProperty(const char* name) {
  char* value = api_mpv_get_property_string(player, name);
  std::string result = value ? value : ""; if (value) api_mpv_free(value); return result;
}
static int command(std::initializer_list<std::string> values, bool async = false) {
  std::vector<const char*> args; for (const auto& value : values) args.push_back(value.c_str()); args.push_back(nullptr);
  return async ? api_mpv_command_async(player, sequence, args.data()) : api_mpv_command(player, args.data());
}
static std::string assEscape(std::string value) {
  std::string result;
  for (const char c : value) {
    if (c == '\\') result += "\\\xE2\x81\xA0";
    else if (c == '{') result += "\\{";
    else if (c == '}') result += "\\}";
    else if (c != '\r' && c != '\n') result += c;
  }
  return result;
}
static std::string f(double value) { return std::to_string(value); }
static std::wstring wide(const std::string& value) {
  std::wstring result(MultiByteToWideChar(CP_UTF8, 0, value.data(), int(value.size()), nullptr, 0), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), int(value.size()), result.data(), int(result.size())); return result;
}
static std::string utf8(const std::wstring& value) {
  std::string result(WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()), nullptr, 0, nullptr, nullptr), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()), result.data(), int(result.size()), nullptr, nullptr); return result;
}
struct BoardRect { double x, y, w, h; };
static BoardRect boardRect() {
  RECT bounds; GetClientRect(host, &bounds);
  const double aspect = overlay.value("aspect", 16.0 / 9.0);
  const double vw = std::min(double(bounds.right), bounds.bottom * aspect), vh = vw / aspect;
  const double bw = vw * .28 * overlay.value("scale", 1.0);
  return {(bounds.right - vw) / 2 + overlay.value("x", 0.0) * vw, (bounds.bottom - vh) / 2 + overlay.value("y", 0.0) * vh, bw, bw / 5.2};
}
static void finishEdit(bool commit) {
  if (!editor) return;
  const HWND window = editor; editor = nullptr;
  std::wstring value(GetWindowTextLengthW(window) + 1, L'\0');
  value.resize(GetWindowTextW(window, value.data(), int(value.size())));
  if (commit) emit({{"type", "scoreboard-edit"}, {"field", editField}, {"clipId", editClipId}, {"value", utf8(value)}});
  DestroyWindow(editorSurface); editorSurface = nullptr;
  if (editorFont) { DeleteObject(editorFont); editorFont = nullptr; }
}
static LRESULT CALLBACK editProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_IME_STARTCOMPOSITION) editComposing = true;
  if (message == WM_IME_ENDCOMPOSITION) editComposing = false;
  if (message == WM_KEYDOWN) {
    if (!editComposing && (wp == VK_RETURN || wp == VK_ESCAPE)) { finishEdit(wp == VK_RETURN); SetFocus(host); return 0; }
    if (wp == 'A' && (GetKeyState(VK_CONTROL) & 0x8000)) { SendMessageW(window, EM_SETSEL, 0, -1); return 0; }
  }
  if (message == WM_KILLFOCUS) { finishEdit(true); return 0; }
  return CallWindowProcW(editorProc, window, message, wp, lp);
}
static void beginEdit(const json& value) {
  finishEdit(true);
  if (!overlay.value("enabled", false)) return;
  editField = value.at("field").get<std::string>(); editClipId = value.value("clipId", std::string());
  editComposing = false;
  const bool name = editField == "leftName" || editField == "rightName";
  if (!name && (editClipId.empty() || editClipId != overlay.value("clipId", std::string()))) return;
  const bool games = editField == "leftGames" || editField == "rightGames";
  const bool bottom = editField.rfind("right", 0) == 0;
  const auto b = boardRect();
  const auto text = wide(name ? overlay.value(editField, std::string()) : std::to_string(overlay.value(editField, 0)));
  // Composite the text box and caret above mpv's D3D swapchain, while keeping
  // the entire inline editor clipped to the video host.
  editorSurface = CreateWindowExW(WS_EX_LAYERED, L"TTcutEditorSurface", L"", WS_CHILD | WS_VISIBLE,
    int(b.x + b.w * (name ? .025 : games ? .76 : .88)), int(b.y + b.h * (bottom ? .5 : 0)), int(b.w * (name ? .71 : .12)), int(b.h * .5), host, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!editorSurface) return;
  SetLayeredWindowAttributes(editorSurface, 0, 255, LWA_ALPHA);
  RECT bounds; GetClientRect(editorSurface, &bounds);
  editor = CreateWindowExW(0, L"EDIT", text.c_str(), WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL | (name ? ES_LEFT : ES_CENTER | ES_NUMBER),
    0, 0, bounds.right, bounds.bottom, editorSurface, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!editor) { DestroyWindow(editorSurface); editorSurface = nullptr; return; }
  editorFont = CreateFontW(-int(b.h * .32), 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei");
  SendMessageW(editor, WM_SETFONT, reinterpret_cast<WPARAM>(editorFont), TRUE);
  SendMessageW(editor, EM_SETLIMITTEXT, name ? 24 : 3, 0);
  editorProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(editor, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(editProc)));
  SetWindowPos(editorSurface, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE); SetFocus(editor); SendMessageW(editor, EM_SETSEL, 0, -1);
}
static void drawOverlay() {
  if (!player || overlay.is_null()) return;
  RECT bounds; GetClientRect(host, &bounds);
  const double w = bounds.right, h = bounds.bottom;
  if (w < 1 || h < 1) return;
  std::string ass;
  if (overlay.value("enabled", false)) {
    const auto b = boardRect(); const double x = b.x, y = b.y, bw = b.w, bh = b.h;
    auto rect = [&](double rx, double ry, double rw, double rh, const char* color) {
      ass += "{\\an7\\pos(" + f(rx) + "," + f(ry) + ")\\bord0\\shad0\\1c&H" + color + "&\\p1}m 0 0 l " + f(rw) + " 0 " + f(rw) + " " + f(rh) + " 0 " + f(rh) + "{\\p0}\n";
    };
    rect(x, y, bw, bh, "292929"); rect(x + bw * .76, y, bw * .12, bh, "F7833A"); rect(x + bw * .88, y, bw * .12, bh, "333333");
    rect(x, y + bh / 2, bw, 1, "777777");
    for (int row = 0; row < 2; row++) {
      const std::string name = overlay.value(row == 0 ? "leftName" : "rightName", std::string(row == 0 ? "A" : "B"));
      const int score = overlay.value(row == 0 ? "left" : "right", 0);
      double units = 0; for (const auto c : wide(name)) units += c < 128 ? .62 : 1.0;
      const double fs = std::min(bh * .32, bw * .70 / std::max(1.0, units));
      const double cy = y + bh * (.25 + row * .5);
      ass += "{\\an4\\pos(" + f(x + bw * .03) + "," + f(cy) + ")\\fnMicrosoft YaHei\\fs" + f(fs) + "\\b1\\bord0\\shad0\\1c&HFFFFFF&}" + assEscape(name) + "\n";
      for (int column = 0; column < 2; column++) {
        const int value = column == 0 ? overlay.value(row == 0 ? "leftGames" : "rightGames", 0) : score;
        ass += "{\\an5\\pos(" + f(x + bw * (column == 0 ? .82 : .94)) + "," + f(cy) + ")\\fnMicrosoft YaHei\\fs" + f(bh * .32) + "\\b1\\bord0\\shad0\\1c&HFFFFFF&}" + std::to_string(value) + "\n";
      }
      rect(x + bw * 1.02, y + bh * row * .5 + 1, bw * .12, bh * .5 - 2, "292929");
      const bool checked = overlay.value("winner", std::string()) == (row == 0 ? "left" : "right");
      const auto symbol = checked ? "\xE2\x9C\x93" : "+";
      const auto color = overlay.value("clipId", std::string()).empty() ? "777777" : checked ? "FFA671" : "FFFFFF";
      ass += "{\\an5\\pos(" + f(x + bw * 1.08) + "," + f(cy) + ")\\fnSegoe UI Symbol\\fs" + f(bh * .38) + "\\b0\\bord0\\shad0\\1c&H" + color + "&}" + symbol + "\n";
    }
    for (const double rx : {x, x + bw}) for (const double ry : {y, y + bh}) rect(rx - 3, ry - 3, 6, 6, "FFFFFF");
  }
  const int result = command({"osd-overlay", "1", "ass-events", ass, std::to_string(int(w)), std::to_string(int(h))});
  if (result < 0) std::cerr << "overlay: " << api_mpv_error_string(result) << '\n';
}
static LRESULT CALLBACK inputProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  auto previous = reinterpret_cast<WNDPROC>(GetPropW(window, L"TTcutOriginalProc"));
  if (message == WM_COMMAND && HIWORD(wp) == EN_CHANGE && reinterpret_cast<HWND>(lp) == editor && editor && !normalizingScore && editField != "leftName" && editField != "rightName") {
    wchar_t text[16]{}; GetWindowTextW(editor, text, 16);
    const std::wstring raw(text); const auto first = raw.find_first_not_of(L'0');
    const std::wstring normalized = first == std::wstring::npos ? L"0" : raw.substr(first);
    if (raw != normalized) { normalizingScore = true; SetWindowTextW(editor, normalized.c_str()); SendMessageW(editor, EM_SETSEL, normalized == L"0" ? 0 : -1, -1); normalizingScore = false; }
    return 0;
  }
  if (message == WM_SYSKEYDOWN && wp == VK_F4) {
    PostMessageW(GetAncestor(host, GA_ROOT), WM_CLOSE, 0, 0); return 0;
  }
  if (message == WM_MOUSEWHEEL) {
    POINT point{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)}; ScreenToClient(host, &point);
    RECT rect; GetClientRect(host, &rect);
    emit({{"type", "wheel"}, {"delta", GET_WHEEL_DELTA_WPARAM(wp)}, {"x", point.x}, {"y", point.y}, {"width", rect.right}, {"height", rect.bottom}}); return 0;
  }
  if (message == WM_SETCURSOR && !overlay.is_null() && overlay.value("enabled", false)) {
    POINT point; GetCursorPos(&point); ScreenToClient(host, &point); const auto b = boardRect();
    const bool left = std::abs(point.x - b.x) < 7, right = std::abs(point.x - b.x - b.w) < 7;
    const bool top = std::abs(point.y - b.y) < 7, bottom = std::abs(point.y - b.y - b.h) < 7;
    if ((left || right) && (top || bottom)) { SetCursor(LoadCursor(nullptr, (left == top) ? IDC_SIZENWSE : IDC_SIZENESW)); return TRUE; }
  }
  if (message == WM_LBUTTONDOWN || message == WM_MOUSEMOVE || message == WM_LBUTTONUP || message == WM_CAPTURECHANGED) {
    if (message != WM_MOUSEMOVE || (wp & MK_LBUTTON)) {
      POINT point{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      MapWindowPoints(window, host, &point, 1); RECT rect; GetClientRect(host, &rect);
      const char* action = message == WM_LBUTTONDOWN ? "down" : message == WM_LBUTTONUP ? "up" : message == WM_CAPTURECHANGED ? "cancel" : "move";
      if (message == WM_LBUTTONDOWN) { SetFocus(window); SetCapture(window); }
      emit({{"type", "pointer"}, {"action", action}, {"x", point.x}, {"y", point.y}, {"width", rect.right}, {"height", rect.bottom}});
      if (message == WM_LBUTTONUP && GetCapture() == window) ReleaseCapture();
      return 0;
    }
  }
  if (message == WM_KEYDOWN && !(lp & (1LL << 30))) {
    std::string key = wp == VK_SPACE ? "Space" : wp == VK_ESCAPE ? "Escape" : wp == 'A' ? "KeyA" : wp == 'D' ? "KeyD" : wp == VK_LEFT ? "ArrowLeft" : wp == VK_RIGHT ? "ArrowRight" : wp == VK_UP ? "ArrowUp" : wp == VK_DOWN ? "ArrowDown" : "";
    if (!key.empty()) { emit({{"type", "key"}, {"key", key}, {"shift", (GetKeyState(VK_SHIFT) & 0x8000) != 0}}); return 0; }
  }
  if (message == WM_ERASEBKGND) return 1;
  return previous ? CallWindowProcW(previous, window, message, wp, lp) : DefWindowProcW(window, message, wp, lp);
}
static BOOL CALLBACK attachInput(HWND window, LPARAM) {
  if (window == editor || window == editorSurface) return TRUE;
  // mpv disables its embedded HWND (w32_common.c). This process owns input,
  // so enable the video child before installing TTcut's input subclass.
  if (!IsWindowEnabled(window)) EnableWindow(window, TRUE);
  if (!GetPropW(window, L"TTcutOriginalProc")) {
    auto previous = reinterpret_cast<WNDPROC>(GetWindowLongPtrW(window, GWLP_WNDPROC));
    SetPropW(window, L"TTcutOriginalProc", reinterpret_cast<HANDLE>(previous));
    SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(inputProc));
  }
  return TRUE;
}
static bool execute(const json& value) {
  const auto op = value.at("op").get<std::string>();
  if (op == "quit") return false;
  if (op == "bounds") {
    const bool visible = value.value("visible", false);
    if (!visible) finishEdit(true);
    SetWindowPos(host, HWND_TOP, value.value("x", 0), value.value("y", 0), std::max(1, value.value("width", 1)), std::max(1, value.value("height", 1)), SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    const int radius = MulDiv(16, GetDpiForWindow(host), 96);
    SetWindowRgn(host, CreateRoundRectRgn(0, 0, std::max(1, value.value("width", 1)) + 1, std::max(1, value.value("height", 1)) + 1, radius, radius), TRUE);
    drawOverlay();
  } else if (op == "load") {
    ready = false; seeking = true; lastPts = -1;
    sequence = value.value("sequence", uint64_t(0));
    api_mpv_set_property_string(player, "hwdec", value.value("software", false) ? "no" : "auto");
    desiredPaused = value.value("paused", true);
    api_mpv_set_property_string(player, "pause", desiredPaused ? "yes" : "no");
    const int result = command({"loadfile", value.at("path").get<std::string>(), "replace", "-1", "start=" + f(value.value("time", 0.0))}, true);
    if (result < 0) error(api_mpv_error_string(result));
  } else if (op == "seek") {
    sequence = value.at("sequence").get<uint64_t>(); seeking = true;
    const int result = command({"seek", f(value.at("time").get<double>()), value.value("exact", true) ? "absolute+exact" : "absolute+keyframes"}, true);
    desiredPaused = value.value("paused", true);
    api_mpv_set_property_string(player, "pause", desiredPaused ? "yes" : "no");
    if (result < 0) error(api_mpv_error_string(result));
  } else if (op == "pause") {
    desiredPaused = value.at("paused").get<bool>();
    api_mpv_set_property_string(player, "pause", desiredPaused ? "yes" : "no");
  } else if (op == "overlay") {
    if (editor && (!value.at("scoreboard").value("enabled", false) || value.at("scoreboard").value("clipId", std::string()) != overlay.value("clipId", std::string()))) finishEdit(true);
    overlay = value.at("scoreboard"); drawOverlay();
  } else if (op == "overlay-edit") {
    beginEdit(value);
  } else if (op == "screenshot") {
    // Main-process acceptance harness only; never exposed through renderer IPC.
    const int result = command({"screenshot-to-file", value.at("path").get<std::string>(), "window"});
    emit({{"type", "screenshot"}, {"ok", result >= 0}});
  }
  return true;
}
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  auto parent = reinterpret_cast<HWND>(std::stoull(argv[1]));
  if (!IsWindow(parent)) return 3;
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  const HMODULE dll = LoadLibraryExW(L"libmpv-2.dll", nullptr, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!dll) { error("MPV_LIBRARY_MISSING"); return 4; }
#define LOAD(name) api_##name = reinterpret_cast<decltype(api_##name)>(GetProcAddress(dll, #name)); if (!api_##name) { error("MPV_API_MISSING:" #name); return 5; }
  MPV_API(LOAD)
  WNDCLASSW wc{}; wc.lpfnWndProc = inputProc; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"TTcutPreview"; wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  RegisterClassW(&wc);
  WNDCLASSW editSurfaceClass{}; editSurfaceClass.lpfnWndProc = inputProc; editSurfaceClass.hInstance = wc.hInstance; editSurfaceClass.lpszClassName = L"TTcutEditorSurface";
  RegisterClassW(&editSurfaceClass);
  host = CreateWindowExW(0, wc.lpszClassName, L"TTcut native preview", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS, 0, 0, 1, 1, parent, nullptr, wc.hInstance, nullptr);
  if (!host) { error("MPV_WINDOW_FAILED:" + std::to_string(GetLastError())); return 6; }
  player = api_mpv_create(); if (!player) return 7;
  auto option = [&](const char* name, const char* value) {
    const int result = api_mpv_set_option_string(player, name, value);
    if (result < 0) throw std::runtime_error(std::string(name) + ":" + api_mpv_error_string(result));
  };
  try {
    const auto handle = std::to_string(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(host)));
    option("config", "no"); option("load-scripts", "no"); option("terminal", "no"); option("osc", "no");
    option("wid", handle.c_str()); option("vo", "gpu-next"); option("gpu-api", "d3d11"); option("gpu-context", "d3d11");
    option("hwdec", "auto"); option("hwdec-software-fallback", "yes"); option("keep-open", "yes"); option("idle", "yes"); option("pause", "yes");
    // Keep the child HWND enabled for hit testing. Our subclass owns transport
    // and pointer input; disabling mpv input here makes clicks pass into Chromium.
    option("input-default-bindings", "no"); option("input-vo-keyboard", "yes"); option("input-cursor", "yes"); option("window-dragging", "no");
    option("osd-level", "0"); option("target-colorspace-hint", "no"); option("target-prim", "bt.709"); option("target-trc", "bt.1886"); option("target-peak", "100");
    option("tone-mapping", "bt.2390"); option("deband", "no"); option("interpolation", "no"); option("scale", "bilinear"); option("dscale", "bilinear");
    option("demuxer-max-bytes", "64MiB"); option("demuxer-max-back-bytes", "16MiB");
    const int initialized = api_mpv_initialize(player); if (initialized < 0) throw std::runtime_error(api_mpv_error_string(initialized));
    api_mpv_request_log_messages(player, "warn");
    emit({{"type", "initialized"}, {"version", textProperty("mpv-version")}});
    std::thread([] {
      std::string line;
      while (std::getline(std::cin, line)) {
        if (line.size() > 65536) { inputClosed = true; break; }
        try { auto value = json::parse(line); std::lock_guard<std::mutex> lock(inputMutex); if (input.size() < 256) input.push_back(std::move(value)); }
        catch (...) { error("INVALID_HOST_COMMAND"); }
      }
      inputClosed = true;
    }).detach();
    bool running = true; ULONGLONG lastState = 0;
    while (running && !inputClosed && IsWindow(parent)) {
      MSG message; while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
      std::deque<json> pending; { std::lock_guard<std::mutex> lock(inputMutex); pending.swap(input); }
      for (const auto& value : pending) { if (!execute(value)) { running = false; break; } }
      while (const auto event = api_mpv_wait_event(player, 0)) {
        if (event->event_id == MPV_EVENT_NONE) break;
        // An old keep-open EOF may pause after asynchronous loadfile was queued.
        // Restore the latest user intent after the replacement file is loaded.
        if (event->event_id == MPV_EVENT_FILE_LOADED) api_mpv_set_property_string(player, "pause", desiredPaused ? "yes" : "no");
        if (event->event_id == MPV_EVENT_PLAYBACK_RESTART) { ready = true; seeking = false; drawOverlay(); }
        if (event->event_id == MPV_EVENT_COMMAND_REPLY && event->error < 0) error(api_mpv_error_string(event->error));
        if (event->event_id == MPV_EVENT_END_FILE) {
          const auto end = static_cast<mpv_event_end_file*>(event->data);
          if (end->reason == MPV_END_FILE_REASON_ERROR) error(api_mpv_error_string(end->error));
        }
        if (event->event_id == MPV_EVENT_LOG_MESSAGE) {
          const auto log = static_cast<mpv_event_log_message*>(event->data);
          std::cerr << log->prefix << ": " << log->text;
        }
      }
      if (GetTickCount64() - lastState >= 33) {
        lastState = GetTickCount64(); EnumChildWindows(host, attachInput, 0);
        const double pts = number("video-pts", number("time-pos"));
        if (ready && pts != lastPts) { samples++; lastPts = pts; }
        emit({{"type", "state"}, {"time", pts}, {"duration", number("duration")}, {"paused", flag("pause")}, {"seeking", seeking || flag("seeking")}, {"ended", flag("eof-reached")}, {"ready", ready}, {"sequence", sequence}, {"samples", samples}, {"decoder", textProperty("hwdec-current")}});
      }
      Sleep(5);
    }
  } catch (const std::exception& exception) { error(exception.what()); }
  api_mpv_terminate_destroy(player); DestroyWindow(host);
  // stdin's reader may still be blocked; process teardown closes the pipe.
  ExitProcess(0);
}
