import Foundation

public struct Presentation: Codable, Equatable {
    public let id: String
    public let localRevision: Int64
    public let title: String
    public let warmupStartIndex: Int
    public let serviceStartIndex: Int
    public let postServiceStartIndex: Int
    public let serviceItems: [ServiceItem]

    public func section(at index: Int) -> String {
        if index >= postServiceStartIndex { return "Post-service" }
        if index >= serviceStartIndex { return "Service" }
        if index >= warmupStartIndex { return "Warm-up" }
        return "Pre-service"
    }

    public func item(id: String) -> ServiceItem? { serviceItems.first { $0.id == id } }
}

public struct ServiceItem: Codable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let kind: String
    public let slides: [Slide]
}

public struct Slide: Codable, Equatable {
    public let index: Int
}

public struct PresentationStatus: Codable, Equatable {
    public let presentationId: String
    public let presentationLocalRevision: Int64
    public let status: SlideStatus
}

public struct SlideStatus: Codable, Equatable {
    public let revision: Int
    public let itemId: String
    public let slideIndex: Int
    public let quickScreenKind: String
    public let mediaState: String?
}

public struct LinkProfile: Codable {
    public var fallbackURL: String = ""
    public var links: [String: String] = [:]
    public init() {}

    public func key(presentationId: String, itemId: String) -> String { "\(presentationId)/\(itemId)" }
    public func link(presentationId: String, itemId: String) -> String {
        links[key(presentationId: presentationId, itemId: itemId)] ?? ""
    }
    public mutating func setLink(_ link: String, presentationId: String, itemId: String) {
        let key = key(presentationId: presentationId, itemId: itemId)
        let value = link.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { links.removeValue(forKey: key) } else { links[key] = value }
    }
}

public struct Destination: Equatable {
    public let url: URL?
    public let isFallback: Bool
    public let reason: String
}

public enum Routing {
    public static func validURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        return url
    }

    public static func resolve(profile: LinkProfile, presentation: Presentation?, status: PresentationStatus?,
                               live: Bool, forceFallback: Bool) -> Destination {
        func fallback(_ reason: String) -> Destination {
            Destination(url: validURL(profile.fallbackURL), isFallback: true, reason: reason)
        }
        if forceFallback { return fallback("Manual Church Center override") }
        guard live, let presentation, let status else { return fallback("No verified live presentation") }
        guard presentation.id == status.presentationId,
              presentation.localRevision == status.presentationLocalRevision else {
            return fallback("Waiting for presentation sync")
        }
        guard status.status.quickScreenKind == "None" else { return fallback("Quick screen is showing") }
        guard let item = presentation.item(id: status.status.itemId),
              item.slides.contains(where: { $0.index == status.status.slideIndex }) else {
            return fallback("Current slide is not in the synced presentation")
        }
        guard let url = validURL(profile.link(presentationId: presentation.id, itemId: item.id)) else {
            return fallback("No link assigned to this item")
        }
        return Destination(url: url, isFallback: false, reason: item.title)
    }
}
