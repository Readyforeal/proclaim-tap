import AppKit
import SwiftUI
import TapCore

enum ConnectionState: String {
    case stopped = "Paused", connecting = "Connecting", disconnected = "Disconnected", offAir = "Off air", live = "On air", demo = "Demo"
}

@MainActor final class AppModel: ObservableObject {
    @Published var connection: ConnectionState = .stopped
    @Published var detail = "Open Proclaim on this Mac to get started."
    @Published var presentation: Presentation?
    @Published var currentStatus: PresentationStatus?
    @Published var lastChecked: Date?
    @Published var lastSynced: Date?
    @Published var selectedItemID: String?
    @Published var search = ""
    @Published var profile = LinkProfile()
    @Published var forceFallback = false
    @Published var storageError: String?
    @Published var syncRequested = false
    @Published var serverSettings = ServerSettings()
    @Published var serverMessage = "Server publishing is off."
    @Published var serverError: String?
    @Published var lastPublished: Date?
    @Published var serverFallbackURL: String?
    @Published var serverConfirmedURL: String?
    private let allowPublishing: Bool
    private let serverClient = ServerClient()
    private var publishingTask: Task<Void, Never>?
    private var publishGeneration = UUID()
    private let publisherID = UUID().uuidString
    private var publishSequence = 0
    private var publishToken = ""
    private var lastSentKey: String?
    private let client = ProclaimClient()
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var sessionId: String?
    private let profileURL: URL

    init(allowPublishing: Bool = true) {
        self.allowPublishing = allowPublishing
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Proclaim Tap", isDirectory: true)
        profileURL = directory.appendingPathComponent("links.json")
        if FileManager.default.fileExists(atPath: profileURL.path) {
            do { profile = try JSONDecoder().decode(LinkProfile.self, from: Data(contentsOf: profileURL)) }
            catch { storageError = "Could not load saved links: \(error.localizedDescription)" }
        }
        if allowPublishing, let data = try? Data(contentsOf: directory.appendingPathComponent("server.json")),
           let settings = try? JSONDecoder().decode(ServerSettings.self, from: data) {
            serverSettings = settings
            if settings.enabled {
                do { publishToken = try TokenStore.load() }
                catch { serverError = error.localizedDescription }
            }
        }
    }

    var publishingHealthy: Bool {
        serverSettings.enabled && serverError == nil && lastPublished.map { Date().timeIntervalSince($0) < 10 } == true
    }
    var destinationDisplayURL: URL? {
        if serverSettings.enabled && destination.isFallback, let fallback = serverFallbackURL {
            return URL(string: fallback)
        }
        return destination.url
    }

    func configureServer(url: String, token: String, enabled: Bool) {
        guard allowPublishing else { return }
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = Routing.validURL(trimmed), (parsed.path.isEmpty || parsed.path == "/"),
              parsed.query == nil, parsed.fragment == nil else {
            serverError = "Enter the HTTPS server address without a path, query, or fragment."
            return
        }
        do {
            let replacement = token.trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = replacement.isEmpty ? (publishToken.isEmpty ? try TokenStore.load() : publishToken) : replacement
            if enabled && chosen.count < 32 {
                serverError = "Enter the server's publish token (at least 32 characters)."
                return
            }
            if !replacement.isEmpty { try TokenStore.save(replacement) }
            let settings = ServerSettings(url: trimmed, enabled: enabled)
            try FileManager.default.createDirectory(at: profileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(settings).write(to: profileURL.deletingLastPathComponent().appendingPathComponent("server.json"), options: .atomic)
            // Clear the previous server best-effort; its TTL remains the final safety net.
            if serverSettings.enabled, let previous = URL(string: serverSettings.url), !publishToken.isEmpty {
                let oldToken = publishToken
                publishSequence += 1
                let clear = PublishUpdate(publisherId: publisherID, sequence: publishSequence, activeURL: nil)
                Task { _ = try? await serverClient.publish(baseURL: previous, token: oldToken, update: clear) }
            }
            publishingTask?.cancel()
            publishingTask = nil
            publishGeneration = UUID()
            serverSettings = settings
            publishToken = chosen
            lastPublished = nil
            lastSentKey = nil
            serverFallbackURL = nil
            serverConfirmedURL = nil
            serverError = nil
            serverMessage = enabled ? "Connecting to the redirect server…" : "Publishing off. Any previous live link expires within the server timeout."
            startPublishing()
        } catch { serverError = error.localizedDescription }
    }

    private func startPublishing() {
        guard allowPublishing, serverSettings.enabled, publishingTask == nil else { return }
        let run = publishGeneration
        publishingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.publishGeneration == run else { return }
                await self.publishIfNeeded(run: run)
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
            }
        }
    }

    private func publishIfNeeded(run: UUID) async {
        guard let base = Routing.validURL(serverSettings.url), !publishToken.isEmpty else {
            serverError = "Add the server URL and publish token in Settings."
            return
        }
        // Never publish simulated or stale slides, even if a Proclaim request stalls.
        let fresh = connection == .live && lastChecked.map { Date().timeIntervalSince($0) < 6 } == true
        let active = fresh && !destination.isFallback ? destination.url?.absoluteString : nil
        let key = active ?? "fallback"
        if lastSentKey == key, let lastPublished, Date().timeIntervalSince(lastPublished) < 5 { return }
        publishSequence += 1
        let update = PublishUpdate(publisherId: publisherID, sequence: publishSequence, activeURL: active)
        do {
            let ack = try await serverClient.publish(baseURL: base, token: publishToken, update: update)
            guard run == publishGeneration, !Task.isCancelled else { return }
            lastSentKey = key
            lastPublished = Date()
            serverError = nil
            serverFallbackURL = ack.fallbackURL
            serverConfirmedURL = ack.destination
            serverMessage = "Server confirmed \(ack.mode == "announcement" ? "announcement link" : "Church Center") · timeout \(ack.ttlSeconds)s"
        } catch {
            guard run == publishGeneration, !Task.isCancelled else { return }
            lastSentKey = nil
            serverError = error.localizedDescription
            serverMessage = "Update not confirmed. Server falls back when its heartbeat expires."
        }
    }

    var isMonitoring: Bool { task != nil }
    var isDemo: Bool { connection == .demo }
    var currentItem: ServiceItem? { presentation?.item(id: currentStatus?.status.itemId ?? "") }
    var selectedItem: ServiceItem? { presentation?.item(id: selectedItemID ?? "") }
    var destination: Destination {
        Routing.resolve(profile: profile, presentation: presentation, status: currentStatus,
                        live: connection == .live || isDemo, forceFallback: forceFallback)
    }
    var visibleItems: [ServiceItem] {
        (presentation?.serviceItems ?? []).filter {
            !$0.slides.isEmpty && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search))
        }
    }
    var mappedCount: Int {
        guard let presentation else { return 0 }
        return presentation.serviceItems.filter { Routing.validURL(link(for: $0.id)) != nil }.count
    }
    func section(for item: ServiceItem) -> String {
        guard let presentation, let index = presentation.serviceItems.firstIndex(where: { $0.id == item.id }) else { return "" }
        return presentation.section(at: index)
    }
    func link(for id: String) -> String {
        guard let presentation else { return "" }
        return profile.link(presentationId: presentation.id, itemId: id)
    }
    func setLink(_ link: String, itemId: String) {
        guard let presentation else { return }
        profile.setLink(link, presentationId: presentation.id, itemId: itemId)
        save()
    }
    func setFallback(_ link: String) {
        profile.fallbackURL = link.trimmingCharacters(in: .whitespacesAndNewlines)
        save()
    }
    private func save() {
        do {
            try FileManager.default.createDirectory(at: profileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(profile).write(to: profileURL, options: .atomic)
            storageError = nil
        } catch { storageError = "Could not save links: \(error.localizedDescription)" }
    }

    func start() {
        stop()
        startPublishing()
        connection = .connecting
        detail = "Looking for Proclaim on this Mac…"
        let run = generation
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.generation == run else { return }
                await self.poll(run: run)
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        generation = UUID()
        sessionId = nil
        currentStatus = nil
        lastChecked = nil
        syncRequested = false
        connection = .stopped
        detail = "Monitoring paused. The destination uses Church Center."
        // Demo items never appear as a cached real presentation.
        if presentation?.id == "demo-presentation" { presentation = nil; selectedItemID = nil }
    }

    func sync() { syncRequested = true }

    private func poll(run: UUID) async {
        do {
            let observedSession = try await client.onAirSession()
            guard generation == run, !Task.isCancelled else { return }
            guard let observedSession else {
                connection = .offAir
                detail = "Proclaim is connected and off air."
                sessionId = nil
                currentStatus = nil
                lastChecked = Date()
                syncRequested = false
                return
            }
            let sessionChanged = observedSession != sessionId
            if sessionChanged {
                currentStatus = nil
                connection = .connecting
                detail = "Syncing the on-air presentation…"
            }
            if sessionChanged || presentation == nil || syncRequested {
                let fresh = try await client.presentation(sessionId: observedSession)
                guard generation == run, !Task.isCancelled else { return }
                apply(fresh)
                sessionId = observedSession
                syncRequested = false
            }
            guard var snapshot = presentation else { return }
            let status = try await client.status(sessionId: observedSession, localRevision: snapshot.localRevision)
            guard generation == run, !Task.isCancelled else { return }
            if status.presentationId != snapshot.id || status.presentationLocalRevision != snapshot.localRevision
                || snapshot.item(id: status.status.itemId) == nil && status.status.quickScreenKind == "None" {
                currentStatus = nil
                let fresh = try await client.presentation(sessionId: observedSession)
                guard generation == run, !Task.isCancelled else { return }
                apply(fresh)
                snapshot = fresh
            }
            guard status.presentationId == snapshot.id, status.presentationLocalRevision == snapshot.localRevision else {
                throw ProclaimError.outOfSync
            }
            currentStatus = status
            connection = .live
            detail = "Following Proclaim · checks about once a second"
            lastChecked = Date()
        } catch {
            guard generation == run, !Task.isCancelled else { return }
            currentStatus = nil
            sessionId = nil
            connection = .disconnected
            detail = "\(error.localizedDescription) Retrying automatically."
        }
    }

    private func apply(_ fresh: Presentation) {
        let changed = fresh.id != presentation?.id
        presentation = fresh
        lastSynced = Date()
        if changed || fresh.item(id: selectedItemID ?? "") == nil {
            selectedItemID = fresh.serviceItems.first(where: { !$0.slides.isEmpty })?.id
        }
    }

    func showDemo() {
        stop()
        let raw = #"{"id":"demo-presentation","localRevision":1,"title":"Sunday at Revival · Demo","warmupStartIndex":3,"serviceStartIndex":4,"postServiceStartIndex":8,"serviceItems":[{"id":"demo-connect","title":"Connect","kind":"Content","slides":[{"index":0}]},{"id":"demo-parents","title":"Parent’s Night Out","kind":"Content","slides":[{"index":0}]},{"id":"demo-football","title":"Flag Football","kind":"Content","slides":[{"index":0}]},{"id":"demo-countdown","title":"Countdown","kind":"Content","slides":[{"index":0}]},{"id":"demo-welcome","title":"Welcome","kind":"Content","slides":[{"index":0}]},{"id":"demo-pioneers","title":"Pioneers Conference","kind":"Content","slides":[{"index":0}]},{"id":"demo-giving","title":"Giving","kind":"Content","slides":[{"index":0}]},{"id":"demo-sermon","title":"Sunday message","kind":"Content","slides":[{"index":0}]}]}"#
        guard let demo = try? JSONDecoder().decode(Presentation.self, from: Data(raw.utf8)) else { return }
        apply(demo)
        connection = .demo
        detail = "Sample presentation. No connection to Proclaim or your server."
        showDemoItem("demo-connect")
    }

    func showDemoItem(_ id: String) {
        guard isDemo, let presentation else { return }
        let raw: [String: Any] = ["presentationId": presentation.id, "presentationLocalRevision": 1,
                                 "status": ["revision": 1, "itemId": id, "slideIndex": 0, "quickScreenKind": "None"]]
        if let data = try? JSONSerialization.data(withJSONObject: raw) {
            currentStatus = try? JSONDecoder().decode(PresentationStatus.self, from: data)
            lastChecked = Date()
        }
    }

    func exportProfile() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "proclaim-tap-links.json"
        panel.title = "Export saved link mappings"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(profile).write(to: url, options: .atomic)
        } catch { storageError = "Export failed: \(error.localizedDescription)" }
    }
}
