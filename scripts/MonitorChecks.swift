import Foundation
import TapCore

// Compile with the actual AppModel source; exercise its async monitor against mock-proclaim.py.
@main struct MonitorChecks {
    @MainActor static func main() async throws {
        let stateFile = URL(fileURLWithPath: "/private/tmp/proclaim-tap-state.json")
        func write(_ state: [String: Any]) throws {
            try JSONSerialization.data(withJSONObject: state).write(to: stateFile, options: .atomic)
        }
        func require(_ condition: Bool, _ message: String) throws {
            if !condition { throw NSError(domain: "MonitorChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func waitFor(_ description: String, _ condition: () -> Bool) async throws {
            for _ in 0..<80 {
                if condition() { print("PASS: \(description)"); return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw NSError(domain: "MonitorChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: "Timed out: \(description)"])
        }

        try write(["onAir": true, "currentItem": 0, "localRevision": 1])
        let model = AppModel(allowPublishing: false)
        // Memory-only links; never change the operator's saved profile.
        model.profile = LinkProfile()
        model.profile.fallbackURL = "https://church.example/"
        model.profile.setLink("https://church.example/connect", presentationId: "integration-fixture", itemId: "fixture-connect")
        model.start()
        defer { model.stop() }
        try await waitFor("connect and auto-sync") { model.connection == .live && model.currentItem?.id == "fixture-connect" }
        try require(model.destination.url?.absoluteString == "https://church.example/connect", "Mapped route")

        try write(["onAir": true, "currentItem": 1, "localRevision": 1])
        try await waitFor("slide changes without manual sync") { model.currentItem?.id == "fixture-parents" }
        try require(model.destination.isFallback, "Unmapped item must use fallback")

        try write(["onAir": true, "currentItem": 0, "localRevision": 2])
        try await waitFor("presentation revision automatically refreshes") {
            model.presentation?.localRevision == 2 && model.currentItem?.id == "fixture-connect"
        }
        try write(["onAir": true, "currentItem": 0, "localRevision": 2, "quickScreenKind": "Blank"])
        try await waitFor("quick screens clear mapped route") {
            model.currentStatus?.status.quickScreenKind == "Blank" && model.destination.isFallback
        }
        try write(["onAir": false])
        try await waitFor("off-air clears current slide") { model.connection == .offAir && model.currentStatus == nil }
        try require(model.destination.isFallback, "Off-air must use fallback")

        try write(["onAir": true, "currentItem": 0, "localRevision": 3])
        try await waitFor("returning on air refetches presentation") { model.connection == .live && model.presentation?.localRevision == 3 }
        try Data("invalid fixture state".utf8).write(to: stateFile, options: .atomic)
        try await waitFor("connection failure clears stale route") { model.connection == .disconnected && model.currentStatus == nil }
        try require(model.destination.isFallback, "Disconnected route must fall back")
        try write(["onAir": true, "currentItem": 1, "localRevision": 4])
        try await waitFor("automatic reconnect recovers the current slide") {
            model.connection == .live && model.currentItem?.id == "fixture-parents" && model.presentation?.localRevision == 4
        }
        model.stop()
        try require(model.connection == .stopped && model.currentStatus == nil && model.destination.isFallback, "Pause must clear state")
        model.start()
        model.stop()
        try await Task.sleep(nanoseconds: 300_000_000)
        try require(model.connection == .stopped && model.currentStatus == nil, "Cancelled poll must not restore live status")
        print("PASS: pause and cancelled requests cannot restore stale status")
        print("All monitor integration checks passed.")
    }
}
