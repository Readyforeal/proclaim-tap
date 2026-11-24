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
        let raw = #"{"id":"cloud-fixture","localRevision":1,"title":"Cloud fixture","warmupStartIndex":0,"serviceStartIndex":0,"postServiceStartIndex":1,"serviceItems":[{"id":"giving","title":"Giving [tap:giving]","kind":"Content","slides":[{"index":0}]}]}"#
        let presentation = try JSONDecoder().decode(Presentation.self, from: Data(raw.utf8))
        var library = try await client.library(baseURL: base, token: token)
        library = try await client.updateLibrary(baseURL: base, token: token,
            mutation: LibraryMutation(baseRevision: library.revision, operation: "savePresentation", presentation: presentation))
        library = try await client.updateLibrary(baseURL: base, token: token,
            mutation: LibraryMutation(baseRevision: library.revision, operation: "saveLink", rule: CloudRule(key: "giving", title: "Giving", url: "https://church.example/give")))
        guard library.link(for: presentation.serviceItems[0]) == "https://church.example/give" else { throw IntegrationFailure(message: "Cloud link round trip failed") }
        let statusRaw = #"{"presentationId":"cloud-fixture","presentationLocalRevision":1,"status":{"revision":1,"itemId":"giving","slideIndex":0,"quickScreenKind":"None"}}"#
        let status = try JSONDecoder().decode(PresentationStatus.self, from: Data(statusRaw.utf8))
        let live = try await client.publishLive(baseURL: base, token: token,
            update: LiveUpdate(publisherId: id, sequence: 4, status: status, forceFallback: false))
        guard live.destination == "https://church.example/give", live.presentationStatus == status else { throw IntegrationFailure(message: "Server did not resolve cloud slide") }
        print("PASS: Swift cloud catalog → Node SQLite → live marker resolution")
    }
}
