import AppKit
let matches = NSRunningApplication.runningApplications(withBundleIdentifier: "com.zlongame.kr.langrisser")
guard matches.count == 1, let game = matches.first else {
    fputs("실행 중인 랑그릿사가 정확히 하나 필요합니다.\n", stderr); exit(1)
}
game.activate(options: [])
let deadline = Date().addingTimeInterval(3)
while Date() < deadline {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == game.processIdentifier { exit(0) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
fputs("게임 창을 전면에 놓지 못했습니다.\n", stderr)
exit(1)
