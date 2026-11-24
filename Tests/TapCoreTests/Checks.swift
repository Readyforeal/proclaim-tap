import Foundation
import TapCore

private let presentationJSON = #"{"id":"p1","localRevision":26506329,"title":"Sunday","warmupStartIndex":1,"serviceStartIndex":2,"postServiceStartIndex":3,"serviceItems":[{"id":"connect-pre","title":"Connect","kind":"Content","slides":[{"index":0}]},{"id":"countdown","title":"Countdown","kind":"Content","slides":[{"index":0}]},{"id":"giving","title":"Giving","kind":"Content","slides":[{"index":0},{"index":1}]},{"id":"connect-post","title":"Connect","kind":"Content","slides":[{"index":0}]}]}"#

struct CheckFailure: Error { let message: String }
func check(_ condition: Bool, _ message: String) throws {
    guard condition else { throw CheckFailure(message: message) }
}

final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.0", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@main struct TapChecks {
    static func status(item: String = "giving", revision: Int64 = 26506329, quick: String = "None", slide: Int = 0, pid: String = "p1") throws -> PresentationStatus {
        let body = """
        {"presentationId":"\(pid)","presentationLocalRevision":\(revision),"status":{"revision":62,"itemId":"\(item)","slideIndex":\(slide),"quickScreenKind":"\(quick)","mediaState":"Playing"}}
        """
        return try JSONDecoder().decode(PresentationStatus.self, from: Data(body.utf8))
    }
    static func client() -> ProclaimClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return ProclaimClient(session: URLSession(configuration: config))
    }
    static func main() async throws {
        let presentation = try JSONDecoder().decode(Presentation.self, from: Data(presentationJSON.utf8))
        var profile = LinkProfile()
        profile.fallbackURL = "https://church.example/"
        profile.setLink("https://church.example/giving", presentationId: "p1", itemId: "giving")
        func route(_ s: PresentationStatus?, live: Bool = true, override: Bool = false) -> Destination {
            Routing.resolve(profile: profile, presentation: presentation, status: s, live: live, forceFallback: override)
        }
        for slide in [0, 1] {
            let destination = route(try status(slide: slide))
            try check(!destination.isFallback && destination.url?.absoluteString == "https://church.example/giving", "Mapped item should resolve for every valid slide")
        }
        try check(route(try status(slide: 2)).isFallback, "Invalid slide must fall back")
        try check(route(nil).isFallback, "Missing status must fall back")
        try check(route(try status(), live: false).isFallback, "Disconnected/off-air state must fall back")
        try check(route(try status(), override: true).isFallback, "Override must win")
        try check(route(try status(quick: "Blank")).isFallback, "Quick screen must fall back")
        try check(route(try status(item: "connect-pre")).isFallback, "Unmapped item must fall back")
        try check(route(try status(item: "missing")).isFallback, "Unknown item must fall back")
        try check(route(try status(revision: 26506330)).isFallback, "Stale revision must fall back")
        try check(route(try status(pid: "different-service")).isFallback, "Wrong presentation must fall back")
        print("PASS: live mappings, multiple slides, stale state, disconnect, quick screens, override, unmapped items")

        profile.setLink("https://church.example/connect", presentationId: "p1", itemId: "connect-pre")
        try check(profile.link(presentationId: "p1", itemId: "connect-post").isEmpty, "Duplicate titles must remain independent")
        try check(profile.link(presentationId: "p2", itemId: "connect-pre").isEmpty, "New services must remain independent")
        let roundTrip = try JSONDecoder().decode(LinkProfile.self, from: JSONEncoder().encode(profile))
        try check(roundTrip.links == profile.links, "Mappings must survive serialization")
        try check((0...3).map { presentation.section(at: $0) } == ["Pre-service", "Warm-up", "Service", "Post-service"], "Section boundaries")
        for raw in ["javascript:alert(1)", "http://example.com", "file:///tmp/test", "https://user:pass@example.com", "https://", "not a URL"] {
            try check(Routing.validURL(raw) == nil, "Invalid destination accepted: \(raw)")
        }
        try check(Routing.validURL("https://church.example/register?event=1") != nil, "Valid HTTPS link rejected")
        print("PASS: mapping persistence, repeated titles, section boundaries, URL validation")

        let id = "ccd663c1eca742b0a32d8c773088832b"
        for body in [id, "\"\(id)\"", "\u{feff}\(id)\n"] {
            MockURLProtocol.handler = { request in
                try check(request.url?.path == "/onair/session", "Wrong session path")
                return (200, Data(body.utf8))
            }
            let result = try await client().onAirSession()
            try check(result == id, "Session format not parsed")
        }
        MockURLProtocol.handler = { _ in (204, Data()) }
        let offAir = try await client().onAirSession()
        try check(offAir == nil, "204 must mean off air")
        print("PASS: plain, JSON, BOM-prefixed session IDs and off-air response")

        MockURLProtocol.handler = { request in
            try check(request.value(forHTTPHeaderField: "OnAirSessionId") == "test-session", "Missing session header")
            try check(request.httpMethod == "GET", "Requests must be read-only")
            if request.url!.path == "/presentations/onair" { return (200, Data(presentationJSON.utf8)) }
            try check(request.url?.path == "/onair/statusChanged", "Wrong status route")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            try check(query.contains(URLQueryItem(name: "localrevision", value: "26506329")), "Missing revision")
            try check(query.contains(URLQueryItem(name: "step", value: "0")), "Missing step")
            return (200, Data(#"{"presentationId":"p1","presentationLocalRevision":26506329,"status":{"revision":62,"itemId":"giving","slideIndex":0,"quickScreenKind":"None"}}"#.utf8))
        }
        let c = client()
        let p = try await c.presentation(sessionId: "test-session")
        let s = try await c.status(sessionId: "test-session", localRevision: p.localRevision)
        try check(p.item(id: s.status.itemId)?.title == "Giving", "Status must resolve to synced item")
        print("PASS: presentation/status requests, session headers, revision and step parameters")

        for code in [403, 404, 500, 200] {
            MockURLProtocol.handler = { _ in (code, Data("<html>Error</html>".utf8)) }
            var rejected = false
            do { _ = try await client().onAirSession() } catch { rejected = true }
            try check(rejected, "Error response must not become a live session")
        }
        MockURLProtocol.handler = { _ in (204, Data()) }
        var rejected = false
        do { _ = try await client().status(sessionId: id, localRevision: 1) } catch { rejected = true }
        try check(rejected, "Empty status must not preserve a live route")
        print("PASS: HTTP errors, malformed sessions, empty slide status")
        let publish = PublishUpdate(publisherId: "test-publisher-0001", sequence: 1, activeURL: nil)
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(publish)) as! [String: Any]
        try check(payload["activeURL"] is NSNull, "Fallback must encode as explicit JSON null")
        MockURLProtocol.handler = { request in
            try check(request.httpMethod == "PUT", "Publisher must use PUT")
            try check(request.url?.path == "/api/state", "Wrong publisher route")
            try check(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token", "Missing bearer token")
            return (200, Data(#"{"destination":"https://church.example/","fallbackURL":"https://church.example/","mode":"fallback","connected":true,"expiresAt":"2026-11-03T19:00:20.000Z","ttlSeconds":20}"#.utf8))
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let publisher = ServerClient(session: URLSession(configuration: config))
        let ack = try await publisher.publish(baseURL: URL(string: "https://tap.example")!, token: "test-token", update: publish)
        try check(ack.mode == "fallback" && ack.ttlSeconds == 20, "Publisher acknowledgement decoding")
        MockURLProtocol.handler = { _ in (401, Data(#"{"error":"Unauthorized"}"#.utf8)) }
        var authRejected = false
        do { _ = try await publisher.publish(baseURL: URL(string: "https://tap.example")!, token: "bad", update: publish) }
        catch { authRejected = true }
        try check(authRejected, "Rejected publish must not be confirmed")
        print("PASS: publisher payload, authentication, fallback null and acknowledgement")
        try check(TapMarker.key(in: "Giving [tap:giving]") == "giving", "Marker detection")
        try check(TapMarker.key(in: "New title [TAP:CONFERENCE-2026]") == "conference-2026", "Marker identity survives title changes")
        for title in ["Giving", "[tap:]", "[tap:has space]", "[tap:one] [tap:two]", "[tap:one] [tap:broken", "[tap:évent]"] {
            try check(TapMarker.key(in: title) == nil, "Malformed or ambiguous marker: \(title)")
        }
        let liveUpdate = LiveUpdate(publisherId: "test-publisher-0001", sequence: 2, status: try status(), forceFallback: false)
        let livePayload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(liveUpdate)) as! [String: Any]
        try check(livePayload["protocolVersion"] as? Int == 2 && livePayload["onAir"] as? Bool == true, "Cloud live protocol")
        try check(livePayload["activeURL"] == nil && livePayload["presentationStatus"] != nil, "Cloud reports slide identity for server routing")
        print("PASS: explicit markers, invalid/ambiguous markers and cloud live protocol")
        print("All checks passed.")
    }
}
