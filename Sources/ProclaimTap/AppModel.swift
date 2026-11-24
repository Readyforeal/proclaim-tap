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
    @Published var cloudLibrary: CloudLibrary?
    @Published var cloudError: String?
    @Published var cloudEditError: String?
    @Published var cloudMessage = "Connect to the server to sync links."
    @Published var cloudSaving = false
    @Published var cloudChecked: Date?
    private var cloudTask: Task<Void, Never>?
    @Published var lastPublished: Date?
    @Published var serverFallbackURL: String?
    @Published var serverConfirmedURL: String?
    private let allowPublishing: Bool
    private let serverClient: ServerClient
    private let loadToken: () throws -> String
    private let saveToken: (String) throws -> Void
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
    private struct LibraryCache: Codable { let serverURL: String; let library: CloudLibrary }
    private let profileURL: URL

    init(allowPublishing: Bool = true, serverClient: ServerClient = ServerClient(), storageDirectory: URL? = nil,
         loadToken: @escaping () throws -> String = TokenStore.load,
         saveToken: @escaping (String) throws -> Void = TokenStore.save) {
        self.allowPublishing = allowPublishing
        self.serverClient = serverClient; self.loadToken = loadToken; self.saveToken = saveToken
        let directory = storageDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Proclaim Tap", isDirectory: true)
        profileURL = directory.appendingPathComponent("links.json")
        if FileManager.default.fileExists(atPath: profileURL.path) {
            do { profile = try JSONDecoder().decode(LinkProfile.self, from: Data(contentsOf: profileURL)) }
            catch { storageError = "Could not load saved links: \(error.localizedDescription)" }
        }
        if allowPublishing, let data = try? Data(contentsOf: directory.appendingPathComponent("server.json")),
           let settings = try? JSONDecoder().decode(ServerSettings.self, from: data) {
            serverSettings = settings
            if settings.enabled || settings.cloudEnabled {
                do { publishToken = try loadToken() }
                catch { serverError = error.localizedDescription }
            }
        }
        if allowPublishing && serverSettings.cloudEnabled,
           let data = try? Data(contentsOf: directory.appendingPathComponent("cloud-cache.json")),
           let cached = try? JSONDecoder().decode(LibraryCache.self, from: data), cached.serverURL == serverSettings.url {
            cloudLibrary = cached.library
            if !serverSettings.monitorLocal { presentation = cached.library.presentations.first; selectedItemID = presentation?.serviceItems.first?.id }
        }
    }

    var usesCloud: Bool { allowPublishing && serverSettings.cloudEnabled && !isDemo }
    var isRemoteEditor: Bool { !serverSettings.monitorLocal }
    var cloudFresh: Bool { cloudChecked.map { Date().timeIntervalSince($0) < 10 } == true && cloudError == nil }
    var publishingHealthy: Bool {
        serverSettings.enabled && serverError == nil && lastPublished.map { Date().timeIntervalSince($0) < 10 } == true
    }
    var destinationDisplayURL: URL? {
        if serverSettings.enabled && destination.isFallback, let fallback = serverFallbackURL {
            return URL(string: fallback)
        }
        return destination.url
    }

    func configureServer(url: String, token: String, enabled: Bool, cloudEnabled: Bool = false, monitorLocal: Bool = true) {
        guard allowPublishing else { return }
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = Routing.validURL(trimmed), (parsed.path.isEmpty || parsed.path == "/"),
              parsed.query == nil, parsed.fragment == nil else {
            serverError = "Enter the HTTPS server address without a path, query, or fragment."
            return
        }
        guard monitorLocal || cloudEnabled else { serverError = "Remote editing requires cloud sync."; return }
        do {
            let replacement = token.trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = replacement.isEmpty ? (publishToken.isEmpty ? try loadToken() : publishToken) : replacement
            if (enabled || cloudEnabled) && chosen.count < 32 {
                serverError = "Enter the server's publish token (at least 32 characters)."
                return
            }
            if !replacement.isEmpty { try saveToken(replacement) }
            let settings = ServerSettings(url: trimmed, enabled: enabled && monitorLocal, cloudEnabled: cloudEnabled, monitorLocal: monitorLocal)
            try FileManager.default.createDirectory(at: profileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(settings).write(to: profileURL.deletingLastPathComponent().appendingPathComponent("server.json"), options: .atomic)
            // Clear the previous server best-effort; its TTL remains the final safety net.
            if serverSettings.enabled && serverSettings.monitorLocal, let previous = URL(string: serverSettings.url), !publishToken.isEmpty {
                let oldToken = publishToken
                publishSequence += 1
                let clear = PublishUpdate(publisherId: publisherID, sequence: publishSequence, activeURL: nil)
                Task { _ = try? await serverClient.publish(baseURL: previous, token: oldToken, update: clear) }
            }
            cloudTask?.cancel()
            cloudTask = nil
            cloudLibrary = nil
            cloudChecked = nil
            cloudError = nil
            cloudEditError = nil
            cloudSaving = false
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
            start()
        } catch { serverError = error.localizedDescription }
    }

    private func startPublishing() {
        guard allowPublishing, serverSettings.enabled, serverSettings.monitorLocal, publishingTask == nil else { return }
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
        let liveStatus = fresh ? currentStatus : nil
        let key = usesCloud
            ? "\(liveStatus?.presentationId ?? "off")/\(liveStatus?.presentationLocalRevision ?? 0)/\(liveStatus?.status.itemId ?? "")/\(liveStatus?.status.slideIndex ?? 0)/\(liveStatus?.status.quickScreenKind ?? "")/\(forceFallback)"
            : active ?? "fallback"
        if lastSentKey == key, let lastPublished, Date().timeIntervalSince(lastPublished) < 5 { return }
        publishSequence += 1
        let update = PublishUpdate(publisherId: publisherID, sequence: publishSequence, activeURL: active)
        do {
            let ack: ServerSnapshot
            if usesCloud {
                ack = try await serverClient.publishLive(baseURL: base, token: publishToken,
                    update: LiveUpdate(publisherId: publisherID, sequence: publishSequence, status: liveStatus, forceFallback: forceFallback))
            } else { ack = try await serverClient.publish(baseURL: base, token: publishToken, update: update) }
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
    var currentItem: ServiceItem? {
        let source = isRemoteEditor ? cloudLibrary?.presentations.first(where: { $0.id == currentStatus?.presentationId }) : presentation
        return source?.item(id: currentStatus?.status.itemId ?? "")
    }
    var selectedItem: ServiceItem? { presentation?.item(id: selectedItemID ?? "") }
    var destination: Destination {
        if usesCloud {
            if isRemoteEditor {
                guard cloudFresh, let live = cloudLibrary?.live else { return Destination(url: nil, isFallback: true, reason: "Waiting for server confirmation") }
                return Destination(url: URL(string: live.destination), isFallback: live.mode == "fallback", reason: live.mode == "fallback" ? "Server is using Church Center" : "Server's live destination")
            }
            var shared = LinkProfile()
            shared.fallbackURL = serverFallbackURL ?? profile.fallbackURL
            if let presentation {
                for item in presentation.serviceItems {
                    shared.setLink(cloudLibrary?.link(for: item) ?? "", presentationId: presentation.id, itemId: item.id)
                }
            }
            return Routing.resolve(profile: shared, presentation: presentation, status: currentStatus,
                live: connection == .live, forceFallback: forceFallback)
        }
        return Routing.resolve(profile: profile, presentation: presentation, status: currentStatus,
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
        if usesCloud, let item = presentation.item(id: id) { return cloudLibrary?.link(for: item) ?? "" }
        return profile.link(presentationId: presentation.id, itemId: id)
    }
    func setLink(_ link: String, itemId: String, expectedURL: String? = nil) {
        guard let presentation else { return }
        if usesCloud {
            guard let item = presentation.item(id: itemId), let key = TapMarker.key(in: item.title) else {
                cloudEditError = "Add one marker such as [tap:giving] to this item's Proclaim title first."; return
            }
            guard expectedURL == nil || expectedURL == cloudLibrary?.link(for: item) else {
                cloudEditError = "This link changed while you were editing. Reload the saved link and review your change."; return
            }
            let rule = CloudRule(key: key, title: item.title, url: link.trimmingCharacters(in: .whitespacesAndNewlines))
            editCloud(operation: rule.url.isEmpty ? "deleteLink" : "saveLink", rule: rule)
            return
        }
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
        startCloudSync()
        startPublishing()
        guard serverSettings.monitorLocal else {
            detail = "Remote editor · the presentation Mac reports the live screen."
            return
        }
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

    private func startCloudSync() {
        guard allowPublishing, serverSettings.cloudEnabled, !publishToken.isEmpty, cloudTask == nil else { return }
        let run = publishGeneration
        cloudTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.publishGeneration == run else { return }
                await self.refreshCloud(run: run)
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            }
        }
    }

    private func acceptCloud(_ library: CloudLibrary) {
        guard library.revision >= (cloudLibrary?.revision ?? -1) else { return }
        if library.revision != cloudLibrary?.revision {
            do {
                try FileManager.default.createDirectory(at: profileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try JSONEncoder().encode(LibraryCache(serverURL: serverSettings.url, library: library))
                    .write(to: profileURL.deletingLastPathComponent().appendingPathComponent("cloud-cache.json"), options: .atomic)
            } catch { storageError = "Links are on the server, but the offline cache could not be saved: \(error.localizedDescription)" }
        }
        cloudLibrary = library
        cloudChecked = Date()
        serverFallbackURL = library.live.fallbackURL
        if isRemoteEditor {
            currentStatus = library.live.connected ? library.live.presentationStatus : nil
            serverConfirmedURL = library.live.destination
            serverMessage = library.live.connected ? "Presentation Mac connected · server destination confirmed" : "No fresh booth heartbeat · Church Center fallback"
            connection = library.live.connected ? .live : .offAir
            detail = "Remote editor · changes are saved to the server."
            let chosen = library.presentations.first(where: { $0.id == presentation?.id })
                ?? library.presentations.first(where: { $0.id == library.live.presentationStatus?.presentationId })
                ?? library.presentations.first
            if let chosen { apply(chosen) }
        }
    }

    private func refreshCloud(run: UUID) async {
        guard let base = Routing.validURL(serverSettings.url) else { return }
        do {
            let library = try await serverClient.library(baseURL: base, token: publishToken)
            guard run == publishGeneration, !Task.isCancelled else { return }
            acceptCloud(library)
            cloudError = nil
            if !cloudSaving && cloudEditError == nil { cloudMessage = "Links synced with server" }
            // Only the booth uploads real snapshots. Browsing on a laptop never uploads its selection.
            if !isRemoteEditor, !isDemo, let presentation,
               library.presentations.first(where: { $0.id == presentation.id }) != presentation, !cloudSaving {
                cloudSaving = true
                defer { if run == publishGeneration { cloudSaving = false } }
                let updated = try await serverClient.updateLibrary(baseURL: base, token: publishToken,
                    mutation: LibraryMutation(baseRevision: library.revision, operation: "savePresentation", presentation: presentation))
                guard run == publishGeneration, !Task.isCancelled else { return }
                acceptCloud(updated)
            }
        } catch {
            guard run == publishGeneration, !Task.isCancelled else { return }
            cloudError = error.localizedDescription
            cloudMessage = "Cloud sync unavailable · saved links are still on the server"
            if isRemoteEditor { connection = .disconnected; currentStatus = nil; detail = "Server connection lost. Displayed presentation is cached." }
        }
    }

    func chooseCloudPresentation(_ id: String) {
        guard isRemoteEditor, let p = cloudLibrary?.presentations.first(where: { $0.id == id }) else { return }
        apply(p)
    }

    private func editCloud(operation: String, rule: CloudRule? = nil, rules: [CloudRule]? = nil) {
        guard !cloudSaving else { cloudEditError = "A sync is in progress. Try saving again in a moment."; return }
        guard let library = cloudLibrary, cloudFresh, let base = Routing.validURL(serverSettings.url) else {
            cloudEditError = "Connect to the server before saving. Your unsaved text stays in this editor."; return
        }
        cloudSaving = true
        cloudMessage = "Saving to server…"
        let run = publishGeneration
        let token = publishToken
        Task {
            defer { if run == publishGeneration { cloudSaving = false } }
            do {
                let updated = try await serverClient.updateLibrary(baseURL: base, token: token,
                    mutation: LibraryMutation(baseRevision: library.revision, operation: operation, rule: rule, rules: rules))
                guard run == publishGeneration else { return }
                acceptCloud(updated)
                cloudEditError = nil
                cloudMessage = "Saved to server · available on every connected Mac"
            } catch {
                guard run == publishGeneration else { return }
                // Never retry an edit automatically against a newer revision.
                cloudEditError = error.localizedDescription
                cloudMessage = "Not saved · review your change and try again"
            }
        }
    }

    func importCurrentLocalLinks() {
        guard let presentation, !isDemo else { return }
        let rules = presentation.serviceItems.compactMap { item -> CloudRule? in
            let url = profile.link(presentationId: presentation.id, itemId: item.id)
            guard let key = TapMarker.key(in: item.title), Routing.validURL(url) != nil else { return nil }
            return CloudRule(key: key, title: item.title, url: url)
        }
        guard !rules.isEmpty else {
            cloudEditError = "No local links with markers found in this presentation. Add markers to the existing Proclaim items, sync, then import again."; return
        }
        editCloud(operation: "importLinks", rules: rules)
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
