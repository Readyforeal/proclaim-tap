import Foundation
import TapCore
struct IntegrationFailure: Error { let message: String }

// Uses only a temporary local Node server and a test-only token supplied by the runner.
@main struct PublishChecks {
    static func main() async throws {
        let base = URL(string: "http://127.0.0.1:3099")!
        let token = ProcessInfo.processInfo.environment["PUBLISH_TOKEN"]!
        let client = ServerClient()
        let id = UUID().uuidString
        let first = try await client.publish(baseURL: base, token: token,
            update: PublishUpdate(publisherId: id, sequence: 1, activeURL: "https://church.example/signup"))
        guard first.mode == "announcement", first.destination == "https://church.example/signup" else {
            throw IntegrationFailure(message: "Announcement update was not applied")
        }
        print("PASS: Swift publisher → Node server announcement update")
        let clear = try await client.publish(baseURL: base, token: token,
            update: PublishUpdate(publisherId: id, sequence: 2, activeURL: nil))
        guard clear.mode == "fallback", clear.destination == "https://church.example/" else {
            throw IntegrationFailure(message: "Fallback was not applied")
        }
        print("PASS: Swift publisher → Node server explicit fallback")
        var rejected = false
        do {
            _ = try await client.publish(baseURL: base, token: "incorrect",
                update: PublishUpdate(publisherId: id, sequence: 3, activeURL: nil))
        } catch { rejected = true }
        guard rejected else { throw IntegrationFailure(message: "Bad token was accepted") }
        print("PASS: live publisher authentication failure")
    }
}
