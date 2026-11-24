import Foundation
import TapCore

final class CloudTestProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> Data)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let data = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@main struct CloudEditorChecks {
    @MainActor static func main() async throws {
        func require(_ condition: Bool, _ message: String) throws {
            if !condition { throw NSError(domain: "CloudEditorChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func waitFor(_ description: String, _ condition: () -> Bool) async throws {
            for _ in 0..<100 {
                if condition() { print("PASS: \(description)"); return }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            throw NSError(domain: "CloudEditorChecks", code: 2, userInfo: [NSLocalizedDescriptionKey: description])
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let settings = ServerSettings(url: "https://cloud-test.invalid", enabled: true, cloudEnabled: true, monitorLocal: false)
        try JSONEncoder().encode(settings).write(to: directory.appendingPathComponent("server.json"))
        let raw = #"{"revision":1,"rules":[],"presentations":[{"id":"p1","localRevision":1,"title":"Sunday","warmupStartIndex":0,"serviceStartIndex":0,"postServiceStartIndex":1,"serviceItems":[{"id":"i1","title":"Giving [tap:giving]","kind":"Content","slides":[{"index":0}]}]}],"live":{"destination":"https://church.example/","fallbackURL":"https://church.example/","mode":"fallback","connected":false,"expiresAt":null,"ttlSeconds":20,"presentationStatus":null}}"#
        var snapshot = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
        var writes = 0
        CloudTestProtocol.handler = { request in
            try require(request.url?.path == "/api/library", "Editor must never publish or contact Proclaim")
            try require(request.value(forHTTPHeaderField: "Authorization") == "Bearer editor-test-token", "Editor authentication")
            if request.httpMethod == "POST" {
                var data = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 4096)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                }
                let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                try require(body["operation"] as? String == "saveLink", "Editor operation")
                try require(body["baseRevision"] as? Int == 1, "Conditional save revision")
                let rule = body["rule"] as! [String: Any]
                try require(rule["key"] as? String == "giving", "Marker identity")
                snapshot["rules"] = [rule]; snapshot["revision"] = 2; writes += 1
            }
            return try JSONSerialization.data(withJSONObject: snapshot)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CloudTestProtocol.self]
        let client = ServerClient(session: URLSession(configuration: config))
        let model = AppModel(serverClient: client, storageDirectory: directory, loadToken: { "editor-test-token" }, saveToken: { _ in })
        model.start()
        try await waitFor("remote editor loads shared presentation without local Proclaim") { model.cloudFresh && model.presentation?.id == "p1" }
        try require(!model.isMonitoring && model.currentStatus == nil, "Remote editor must not run the local monitor")
        model.setLink("https://church.example/give", itemId: "i1", expectedURL: "")
        try await waitFor("cloud save waits for server acknowledgement") { model.cloudLibrary?.revision == 2 && !model.cloudSaving }
        try require(writes == 1 && model.link(for: "i1") == "https://church.example/give", "Confirmed shared link")
        model.setLink("https://church.example/stale", itemId: "i1", expectedURL: "")
        try require(model.cloudEditError != nil && writes == 1, "Stale editor text must not overwrite a refreshed value")
        let cached = AppModel(serverClient: client, storageDirectory: directory, loadToken: { "" }, saveToken: { _ in })
        try require(cached.presentation?.id == "p1" && !cached.cloudFresh && cached.currentStatus == nil && cached.destination.isFallback, "Cached data must never imply live status")
        let legacy = try JSONDecoder().decode(ServerSettings.self, from: Data(#"{"url":"https://tap.example","enabled":true}"#.utf8))
        try require(!legacy.cloudEnabled && legacy.monitorLocal, "Old installations must retain local mode until migration")
        print("PASS: edit conflict protection, offline cache and legacy settings migration")
        model.configureServer(url: "https://cloud-test.invalid", token: "", enabled: false, cloudEnabled: false, monitorLocal: true)
        model.stop()
        print("All cloud editor checks passed.")
    }
}
