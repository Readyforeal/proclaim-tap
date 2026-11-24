import Foundation

public struct PublishUpdate: Encodable {
    public let publisherId: String
    public let sequence: Int
    public let sentAt: String
    public let activeURL: String?
    public init(publisherId: String, sequence: Int, activeURL: String?, date: Date = Date()) {
        self.publisherId = publisherId
        self.sequence = sequence
        self.activeURL = activeURL
        self.sentAt = ISO8601DateFormatter().string(from: date)
    }
    enum CodingKeys: String, CodingKey { case publisherId, sequence, sentAt, activeURL }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(publisherId, forKey: .publisherId)
        try c.encode(sequence, forKey: .sequence)
        try c.encode(sentAt, forKey: .sentAt)
        if let activeURL { try c.encode(activeURL, forKey: .activeURL) } else { try c.encodeNil(forKey: .activeURL) }
    }
}

public struct ServerSnapshot: Codable {
    public let destination: String
    public let fallbackURL: String
    public let mode: String
    public let connected: Bool
    public let expiresAt: String?
    public let ttlSeconds: Int
    public let presentationStatus: PresentationStatus?
}

public struct PublishError: LocalizedError {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}

// Refuse redirects on authenticated requests; a misconfigured proxy must not forward the token.
public final class ServerClient: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private struct ErrorBody: Decodable { let error: String }
    private let injectedSession: URLSession?
    private lazy var ownedSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 5
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    public init(session: URLSession? = nil) { injectedSession = session; super.init() }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    public func publish(baseURL: URL, token: String, update: PublishUpdate) async throws -> ServerSnapshot {
        try await request(baseURL: baseURL, token: token, path: "api/state", method: "PUT", body: JSONEncoder().encode(update))
    }
    public func publishLive(baseURL: URL, token: String, update: LiveUpdate) async throws -> ServerSnapshot {
        try await request(baseURL: baseURL, token: token, path: "api/state", method: "PUT", body: JSONEncoder().encode(update))
    }
    public func library(baseURL: URL, token: String) async throws -> CloudLibrary {
        try await request(baseURL: baseURL, token: token, path: "api/library", method: "GET")
    }
    public func updateLibrary(baseURL: URL, token: String, mutation: LibraryMutation) async throws -> CloudLibrary {
        try await request(baseURL: baseURL, token: token, path: "api/library", method: "POST", body: JSONEncoder().encode(mutation))
    }
    private func request<T: Decodable>(baseURL: URL, token: String, path: String, method: String, body: Data? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await (injectedSession ?? ownedSession).data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Server returned HTTP \(code)"
            throw PublishError(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
