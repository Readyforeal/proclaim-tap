import Foundation

public enum ProclaimError: LocalizedError {
    case http(Int), invalidSession, emptyStatus, outOfSync
    public var errorDescription: String? {
        switch self {
        case .http(let code): return "Proclaim returned HTTP \(code). Check Settings → Remote → Enable."
        case .invalidSession: return "Proclaim returned an unexpected session ID."
        case .emptyStatus: return "Proclaim did not return a current slide."
        case .outOfSync: return "Presentation changed; waiting for matching slide data."
        }
    }
}

public final class ProclaimClient {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL = URL(string: "http://127.0.0.1:52195")!, session: URLSession? = nil) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 5
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.connectionProxyDictionary = [:]
        self.session = session ?? URLSession(configuration: config)
    }

    private func get(_ path: String, sessionId: String? = nil, query: [URLQueryItem] = []) async throws -> (Data, Int) {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let sessionId { request.setValue(sessionId, forHTTPHeaderField: "OnAirSessionId") }
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw ProclaimError.http(code) }
        // Some Proclaim versions include a UTF-8 BOM despite declaring JSON/plain text.
        let cleaned = data.starts(with: [0xef, 0xbb, 0xbf]) ? Data(data.dropFirst(3)) : data
        return (cleaned, code)
    }

    public func onAirSession() async throws -> String? {
        let (data, code) = try await get("onair/session")
        if code == 204 { return nil }
        let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if raw.isEmpty { return nil }
        let value = (try? JSONDecoder().decode(String.self, from: data)) ?? raw
        let compact = value.replacingOccurrences(of: "-", with: "")
        guard compact.count == 32, compact.allSatisfy({ $0.isHexDigit }) else { throw ProclaimError.invalidSession }
        return value
    }

    public func presentation(sessionId: String) async throws -> Presentation {
        let (data, _) = try await get("presentations/onair", sessionId: sessionId)
        return try JSONDecoder().decode(Presentation.self, from: data)
    }

    public func status(sessionId: String, localRevision: Int64) async throws -> PresentationStatus {
        let (data, code) = try await get("onair/statusChanged", sessionId: sessionId, query: [
            URLQueryItem(name: "localrevision", value: String(localRevision)),
            URLQueryItem(name: "step", value: "0")
        ])
        guard code != 204, !data.isEmpty else { throw ProclaimError.emptyStatus }
        return try JSONDecoder().decode(PresentationStatus.self, from: data)
    }
}
