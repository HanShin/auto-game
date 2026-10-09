import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision
import ImageIO
import UniformTypeIdentifiers

// Newline-delimited JSON protocol. Only the configured game window is captured.
struct BridgeError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

@main struct GameBridge {
    static let bundleID = "com.zlongame.kr.langrisser"
    @MainActor static var lastWindow: SCWindow?
    @MainActor static var lastCaptureAt = Date.distantPast
    @MainActor static var generation = 0

    @MainActor static func waitFor<T>(_ start: (@escaping (T?, Error?) -> Void) -> Void) throws -> T {
        let lock = NSLock()
        var finished = false
        var value: T?
        var failure: Error?
        start { result, error in
            lock.lock(); defer { lock.unlock() }
            value = result; failure = error; finished = true
        }
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            lock.lock(); let done = finished; lock.unlock()
            if done { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        lock.lock(); defer { lock.unlock() }
        if let failure { throw failure }
        guard finished, let value else { throw BridgeError("CAPTURE_TIMEOUT") }
        return value
    }
    static func output(_ object: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) { print(line); fflush(stdout) }
    }
    static func rect(_ r: CGRect) -> [String: Double] {
        ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
    }
    @MainActor static func window() throws -> SCWindow {
        guard CGPreflightScreenCaptureAccess() else {
            throw BridgeError("SCREEN_RECORDING_REQUIRED: 실행 앱의 화면 및 시스템 오디오 녹음 권한이 필요합니다.")
        }
        let content: SCShareableContent = try waitFor { done in SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true, completionHandler: done) }
        let matches = content.windows.filter {
            $0.owningApplication?.bundleIdentifier == bundleID && $0.windowLayer == 0 && $0.frame.width > 300 && $0.frame.height > 200
        }
        guard matches.count == 1, let chosen = matches.first else {
            throw BridgeError("GAME_WINDOW_REQUIRED: 표시 중인 랑그릿사 창이 정확히 하나 필요합니다. 발견: \(matches.count)")
        }
        return chosen
    }
    static func recognize(_ image: CGImage) throws -> [[String: Any]] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["ko-KR", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { item in
            guard let candidate = item.topCandidates(1).first else { return nil }
            let b = item.boundingBox
            return ["text": candidate.string, "confidence": candidate.confidence,
                    "box": ["x": b.minX, "y": 1-b.maxY, "width": b.width, "height": b.height]]
        }
    }
    @MainActor static func capture(_ args: [String: Any]) throws -> [String: Any] {
        fputs("capture: locating window\n", stderr)
        let w = try window()
        fputs("capture: screenshot\n", stderr)
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let config = SCStreamConfiguration()
        config.width = Int((w.frame.width * CGFloat(filter.pointPixelScale)).rounded())
        config.height = Int((w.frame.height * CGFloat(filter.pointPixelScale)).rounded())
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.includeChildWindows = false
        let capturedAt = Date()
        let image: CGImage = try waitFor { done in SCScreenshotManager.captureImage(contentFilter: filter, configuration: config, completionHandler: done) }
        guard let path = args["path"] as? String, path.hasPrefix("/") else { throw BridgeError("절대 PNG 경로가 필요합니다.") }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw BridgeError("PNG 생성 실패") }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw BridgeError("PNG 저장 실패") }
        fputs("capture: OCR\n", stderr)
        let text = try recognize(image)
        lastWindow = w; lastCaptureAt = capturedAt; generation += 1
        return ["path": path, "frame": rect(w.frame), "windowId": w.windowID,
                "pid": w.owningApplication?.processID ?? 0, "width": image.width, "height": image.height,
                "generation": generation, "text": text, "elapsedMs": Date().timeIntervalSince(capturedAt) * 1000,
                "frontmost": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID]
    }
    @MainActor static func input(_ args: [String: Any], drag: Bool) throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw BridgeError("ACCESSIBILITY_REQUIRED: 실행 앱의 손쉬운 사용 권한이 필요합니다.") }
        guard let old = lastWindow, let expected = args["generation"] as? Int, expected == generation,
              Date().timeIntervalSince(lastCaptureAt) < 15 else { throw BridgeError("STALE_FRAME: 새 화면 확인 후 입력하세요.") }
        let w = try window()
        guard old.windowID == w.windowID, old.frame.equalTo(w.frame),
              old.owningApplication?.processID == w.owningApplication?.processID else { throw BridgeError("WINDOW_CHANGED: 창이 이동하거나 변경되었습니다.") }
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { throw BridgeError("GAME_NOT_FRONTMOST: 게임을 전면에 두세요.") }
        func point(_ key: String) throws -> CGPoint {
            guard let a = args[key] as? [Double], a.count == 2, a.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }),
                  a[1] * w.frame.height > 32 else { throw BridgeError("INVALID_POINT: 게임 내용 영역의 0~1 좌표가 필요합니다.") }
            return CGPoint(x: w.frame.minX + a[0] * w.frame.width, y: w.frame.minY + a[1] * w.frame.height)
        }
        let from = try point("point")
        let to = drag ? try point("to") : from
        let duration = args["durationMs"] as? Double ?? 250
        guard duration.isFinite, duration >= 50, duration <= 3000 else { throw BridgeError("INVALID_DURATION") }
        let source = CGEventSource(stateID: .hidSystemState)
        func post(_ type: CGEventType, _ p: CGPoint) throws {
            guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { throw BridgeError("입력 이벤트 생성 실패") }
            e.post(tap: .cghidEventTap)
        }
        // Invalidate before dispatch so an ambiguous result cannot be replayed blindly.
        lastCaptureAt = .distantPast
        try post(.mouseMoved, from)
        try post(.leftMouseDown, from)
        defer { try? post(.leftMouseUp, to) }
        if drag {
            let steps = 20
            for i in 1...steps {
                Thread.sleep(forTimeInterval: duration / Double(steps) / 1000)
                let t = Double(i) / Double(steps)
                try post(.leftMouseDragged, CGPoint(x: from.x+(to.x-from.x)*t, y: from.y+(to.y-from.y)*t))
            }
        } else { Thread.sleep(forTimeInterval: 0.07) }
        return ["sent": true]
    }
    @MainActor static func handle(_ args: [String: Any]) throws -> [String: Any] {
        switch args["command"] as? String {
        case "doctor":
            return ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
                    "gameRunning": !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty,
                    "bundleId": bundleID]
        case "capture": return try capture(args)
        case "click": return try input(args, drag: false)
        case "drag": return try input(args, drag: true)
        default: throw BridgeError("알 수 없는 명령")
        }
    }
    @MainActor static func main() {
        _ = NSApplication.shared
        #if PILOT_APP
        if !CommandLine.arguments.contains("--bridge") { PilotUI.run(); return }
        #endif
        while let line = readLine() {
            var id: Any = NSNull()
            do {
                guard let bytes = line.data(using: .utf8), let args = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw BridgeError("JSON 객체가 필요합니다.") }
                id = args["id"] ?? NSNull()
                let result = try handle(args)
                output(["id": id, "ok": true, "result": result])
            } catch { output(["id": id, "ok": false, "error": error.localizedDescription]) }
        }
    }
}
