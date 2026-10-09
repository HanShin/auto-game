import AppKit
import ApplicationServices

@MainActor final class PilotUI: NSObject, NSApplicationDelegate {
    static var instance: PilotUI?
    var window: NSWindow!
    let output = NSTextView()
    var child: Process?
    var runDirectory: String?
    var project: String { Bundle.main.object(forInfoDictionaryKey: "PilotProject") as! String }
    static func run() {
        let ui = PilotUI(); instance = ui
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.delegate = ui
        NSApplication.shared.run()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(), item = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle:"종료",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q")
        item.submenu = appMenu; menu.addItem(item); NSApplication.shared.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 520), styleMask: [.titled,.closable,.miniaturizable,.resizable], backing: .buffered, defer: false)
        window.title = "문 너머 저편 — 실행 도구 (검증 중)"
        let view = window.contentView!
        let data = try? Data(contentsOf:URL(fileURLWithPath:project+"/data/langrisser/guides.json"))
        let guideData = data.flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:Any] }
        let coverage = guideData?["coverage"] as? [String:Any]
        let title = NSTextField(labelWithString: "공략 \(coverage?["indexedStages"] as? Int ?? 0)개 저장 · 자동 완주 검증 \(coverage?["verifiedAutomaticClears"] as? Int ?? 0)개")
        title.frame = NSRect(x: 20,y: 475,width: 740,height: 24); view.addSubview(title)
        let labels = ["권한 확인", "화면 읽기", "공략 보기", "계획 실행", "중지"]
        let selectors: [Selector] = [#selector(doctor),#selector(capture),#selector(guides),#selector(choosePlan),#selector(stop)]
        for (i,label) in labels.enumerated() {
            let button = NSButton(title: label, target: self, action: selectors[i])
            button.frame = NSRect(x: 20+i*150,y: 432,width: 140,height: 32); view.addSubview(button)
        }
        let scroll = NSScrollView(frame: NSRect(x:20,y:20,width:740,height:400))
        scroll.autoresizingMask = [.width,.height]; scroll.hasVerticalScroller = true
        output.isEditable = false; output.font = NSFont.monospacedSystemFont(ofSize: 12, weight:.regular)
        output.isVerticallyResizable = true; output.autoresizingMask = [.width]
        output.textContainer?.widthTracksTextView = true
        scroll.documentView = output; view.addSubview(scroll)
        window.center(); window.makeKeyAndOrderFront(nil); NSApplication.shared.activate(ignoringOtherApps:true)
        append("전투 자동 완주는 아직 준비 중입니다.\n‘계획 실행’에서 JSON 실행 계획을 선택합니다. 각 입력 전후 화면을 확인합니다.\n메뉴 입력 왕복 검증 완료. 전투 계획은 아직 작성·검증 중입니다.\n")
        doctor()
    }
    func append(_ text: String) { output.textStorage?.append(NSAttributedString(string:text)); output.scrollToEndOfDocument(nil) }
    @objc func doctor() {
        append("\n화면 녹음: \(CGPreflightScreenCaptureAccess() ? "허용" : "필요") / 기기 제어 및 데이터 접근: \(AXIsProcessTrusted() ? "허용" : "필요")\n")
        append("필요한 권한은 시스템 설정 > 개인정보 보호 및 보안에서 이 앱에 허용하세요.\n")
    }
    func launch(_ arguments: [String]) {
        guard child == nil else { append("이미 실행 중입니다.\n"); return }
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath:Bundle.main.object(forInfoDictionaryKey:"PilotNode") as! String)
        process.arguments = [project + "/scripts/langrisser.mjs"] + arguments
        process.currentDirectoryURL = URL(fileURLWithPath:project)
        var env = ProcessInfo.processInfo.environment
        env["GAME_BRIDGE_BINARY"] = Bundle.main.executablePath!
        process.environment = env; process.standardOutput = pipe; process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            let text = String(decoding:data,as:UTF8.self)
            DispatchQueue.main.async { self?.append(text) }
        }
        process.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.child = nil; self?.append("\n종료 코드: \(p.terminationStatus)\n") }
        }
        do { try process.run(); child = process } catch { pipe.fileHandleForReading.readabilityHandler = nil; append(error.localizedDescription+"\n") }
    }
    @objc func capture() { launch(["capture"]) }
    @objc func guides() { NSWorkspace.shared.open(URL(fileURLWithPath:project+"/docs/LANGRISSER-GUIDES.md")) }
    @objc func choosePlan() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath:project+"/profiles/langrisser")
        if panel.runModal() == .OK, let url = panel.url { runPlan(url.path) }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        guard filenames.count == 1 else { append("실행 계획 하나만 여세요.\n"); return }
        runPlan(filenames[0])
    }
    func runPlan(_ path: String) {
        guard child == nil else { return }
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { doctor(); return }
        runDirectory = project+"/.runtime/langrisser/run-"+UUID().uuidString
        append("5초 뒤 계획을 시작합니다: \(path)\n실행 기록: \(runDirectory!)\n")
        launch(["run",path,"--live","--delay","--run-dir",runDirectory!])
    }
    @objc func stop() {
        if let directory = runDirectory {
            try? FileManager.default.createDirectory(atPath:directory,withIntermediateDirectories:true)
            try? "stop\n".write(toFile:directory+"/STOP",atomically:true,encoding:.utf8)
        }
        child?.interrupt(); append("중지를 요청했습니다. 현재 입력 결과는 다시 확인해야 할 수 있습니다.\n")
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification:Notification) { stop() }
}
