import AppKit
import SwiftUI
import TapCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct ProclaimTapApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup("Proclaim Tap") {
            ContentView(model: model)
                .frame(minWidth: 1000, minHeight: 680)
                .tint(.orange)
                .task {
                    if ProcessInfo.processInfo.arguments.contains("--demo") { model.showDemo() }
                    else { model.start() }
                }
        }
        .defaultSize(width: 1180, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Presentation") {
                Button("Sync Presentation") { model.sync() }
                    .keyboardShortcut("r", modifiers: .command)
                    .disabled(!model.isMonitoring)
                Button("Export Link Mappings…") { model.exportProfile() }
            }
        }
    }
}

struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var showSettings = false
    private var statusColor: Color {
        switch model.connection {
        case .live: return .green
        case .demo, .connecting: return .orange
        default: return .secondary
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HSplitView {
                library.frame(minWidth: 330, idealWidth: 390, maxWidth: 480)
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        liveCard
                        destinationCard
                        editor
                        if model.usesCloud {
                            Text(model.cloudMessage).font(.callout).foregroundStyle(.secondary)
                            if let error = model.cloudEditError ?? model.cloudError { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
                        }
                        if let error = model.storageError {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red).font(.callout)
                        }
                    }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 550)
            }
            Divider()
            footer
        }
        .sheet(isPresented: $showSettings) { SettingsView(model: model) }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "wave.3.right.circle.fill").font(.system(size: 36)).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text("Proclaim Tap").font(.title2.bold())
                Text("REVIVAL  /  PRESENTATION COMPANION")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.1).foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 7) {
                Circle().fill(statusColor).frame(width: 7, height: 7)
                Text(model.connection.rawValue).font(.callout.weight(.medium))
            }.padding(.horizontal, 12).padding(.vertical, 7).background(statusColor.opacity(0.12), in: Capsule())
            if model.isRemoteEditor {
                Text("Remote editor").font(.callout).foregroundStyle(.secondary)
            } else if model.isMonitoring {
                Button("Pause", systemImage: "pause.fill") { model.stop() }
            } else {
                Button("Connect to Proclaim", systemImage: "antenna.radiowaves.left.and.right") { model.start() }
                    .buttonStyle(.borderedProminent)
            }
            Button { showSettings = true } label: { Image(systemName: "gearshape") }
                .help("Server connection, cloud links, and device role")
        }.padding(.horizontal, 24).padding(.vertical, 18)
    }

    private var library: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("PRESENTATION").font(.caption.weight(.semibold)).foregroundStyle(.secondary).tracking(1.1)
                    Spacer()
                    Button { model.sync() } label: {
                        Label(model.syncRequested ? "Syncing…" : "Sync", systemImage: "arrow.triangle.2.circlepath")
                    }.disabled(!model.isMonitoring || model.connection == .offAir || model.syncRequested)
                }
                if model.isRemoteEditor, let cloud = model.cloudLibrary, !cloud.presentations.isEmpty {
                    Picker("Presentation", selection: Binding(get: { model.presentation?.id ?? "" }, set: { model.chooseCloudPresentation($0) })) {
                        ForEach(cloud.presentations, id: \.id) { p in Text(p.title).tag(p.id) }
                    }
                }
                Text(model.presentation?.title ?? (model.isRemoteEditor ? "Waiting for the presentation Mac" : "Waiting for Proclaim")).font(.title3.weight(.semibold))
                HStack(spacing: 5) {
                    Text("\(model.visibleItems.count) items")
                    Text("·")
                    Text("\(model.mappedCount) linked")
                    if model.connection != .live && !model.isDemo && model.presentation != nil {
                        Text("· Cached list")
                    }
                }.font(.caption).foregroundStyle(.secondary)
                TextField("Find an announcement", text: $model.search)
                    .textFieldStyle(.roundedBorder)
            }.padding(20)
            Divider()
            if model.presentation == nil {
                VStack(alignment: .leading, spacing: 16) {
                    Image(systemName: "rectangle.on.rectangle.slash").font(.largeTitle).foregroundStyle(.secondary)
                    Text("Bring your service into view").font(.headline)
                    Text(model.isRemoteEditor ? "Connect to the server in Settings. Presentations appear after the booth Mac uploads them; you can edit uploaded presentations while that Mac is off." : "On this Mac, open Proclaim, enable Settings → Remote, and go On Air. Your presentation will sync automatically.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if !model.isRemoteEditor { Button("Explore a sample presentation") { model.showDemo() } }
                }.padding(24)
                Spacer()
            } else {
                List(selection: $model.selectedItemID) {
                    ForEach(model.visibleItems) { item in
                        HStack(spacing: 10) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(model.currentItem?.id == item.id ? Color.orange : Color.clear)
                                .frame(width: 3, height: 30)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title).font(.system(size: 13, weight: .medium))
                                Text(model.section(for: item)).font(.caption).foregroundStyle(.secondary)
                                if model.usesCloud, item.title.lowercased().contains("[tap:"), model.link(for: item.id).isEmpty {
                                    Text(TapMarker.key(in: item.title) == nil ? "Check tap marker" : "Tap link needed")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                            }
                            Spacer()
                            if Routing.validURL(model.link(for: item.id)) != nil {
                                Image(systemName: "link").font(.caption).foregroundStyle(.orange)
                            }
                        }.padding(.vertical, 5).tag(item.id)
                    }
                }.listStyle(.sidebar)
            }
        }.background(Color(nsColor: .controlBackgroundColor).opacity(0.4))
    }

    private var liveCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                eyebrow(model.isDemo ? "SIMULATED SCREEN" : "ON SCREEN NOW")
                Spacer()
                if let status = model.currentStatus {
                    Text("Slide \(status.status.slideIndex + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Text(liveTitle).font(.system(size: 32, weight: .semibold)).lineLimit(2)
            if let item = model.currentItem {
                Text(model.isRemoteEditor ? (model.cloudLibrary?.presentations.first(where: { $0.id == model.currentStatus?.presentationId })?.title ?? "") : model.section(for: item)).font(.callout).foregroundStyle(.secondary)
            }
            Text(model.detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .padding(24).background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.orange.opacity(0.18)))
    }
    private var liveTitle: String {
        if let status = model.currentStatus, status.status.quickScreenKind != "None" {
            return "Quick screen: \(status.status.quickScreenKind)"
        }
        if let item = model.currentItem { return item.title }
        switch model.connection {
        case .offAir: return "Ready for the next service"
        case .stopped: return "Monitoring paused"
        case .live: return "Unknown presentation item"
        default: return "Waiting for a live slide"
        }
    }

    private var destinationCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                eyebrow("TAP DESTINATION PREVIEW")
                Spacer()
                Text(model.isRemoteEditor ? (model.cloudFresh ? "SERVER STATUS" : "NOT CONFIRMED") : (model.publishingHealthy ? "PUBLISHING" : (model.serverSettings.enabled ? "NOT CONFIRMED" : "LOCAL ONLY")))
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .padding(5).background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
            }
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: model.destination.isFallback ? "house" : "arrow.up.right")
                    .font(.title2).foregroundStyle(.orange).frame(width: 28)
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.destination.isFallback ? "Church Center" : model.destination.reason).font(.headline)
                    Text(model.destinationDisplayURL?.absoluteString ?? "Add your Church Center URL in Settings")
                        .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if model.destination.isFallback {
                        Text(model.destination.reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if let url = model.destinationDisplayURL {
                    Button { NSWorkspace.shared.open(url) } label: { Image(systemName: "arrow.up.right.square") }
                        .help("Open this link in your browser")
                }
            }
            Divider().padding(.vertical, 3)
            if !model.isRemoteEditor { Toggle("Use Church Center for every tap", isOn: $model.forceFallback).toggleStyle(.switch) }
            Text(model.serverMessage)
                .font(.caption).foregroundStyle(.secondary)
            if let error = model.serverError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if model.serverSettings.enabled || model.isRemoteEditor, let confirmed = model.serverConfirmedURL {
                Text("Last confirmed: \(confirmed)").font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }.padding(22).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var editor: some View {
        if let item = model.selectedItem {
            VStack(alignment: .leading, spacing: 12) {
                eyebrow("SELECTED ITEM")
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.title3.weight(.semibold))
                        Text("\(model.section(for: item)) · \(item.slides.count) slide\(item.slides.count == 1 ? "" : "s")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.isDemo {
                        Button("Show in demo") { model.showDemoItem(item.id) }
                    }
                }
                LinkEditor(value: model.link(for: item.id)) { value, previous in model.setLink(value, itemId: item.id, expectedURL: previous) }
                    .disabled(model.usesCloud && (TapMarker.key(in: item.title) == nil || model.cloudSaving || !model.cloudFresh))
                    .id("\(model.presentation?.id ?? "")/\(item.id)")
                Text(model.usesCloud
                    ? (TapMarker.key(in: item.title).map { "[tap:\($0)] · This URL applies to every item using this marker, including future weekly duplicates. Clearing it removes the shared link everywhere." }
                       ?? "Add exactly one marker such as [tap:giving] to this item's title in Proclaim. Unmarked items use Church Center.")
                    : "Leave empty to use Church Center. This local link applies to every slide in this item; each copy has its own mapping.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer")
            Text(model.isRemoteEditor ? "Remote editor · \(model.serverSettings.url)" : "Proclaim on this Mac · 127.0.0.1:52195")
            Spacer()
            if let checked = model.lastChecked {
                Text("Last response")
                Text(checked, style: .time).monospacedDigit()
            }
        }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 24).padding(.vertical, 10)
    }
    private func eyebrow(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundStyle(.secondary)
    }
}

struct LinkEditor: View {
    let value: String
    let save: (String, String) -> Void
    @State private var draft = ""
    @State private var baseline = ""
    private var isValid: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Routing.validURL(draft) != nil }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("https://…", text: $draft).textFieldStyle(.roundedBorder)
                    .onSubmit { commit() }
                Button("Save link") { commit() }.disabled(!isValid)
            }
            if !isValid { Text("Enter a full HTTPS link, or leave this empty.").font(.caption).foregroundStyle(.red) }
            if draft != value {
                Button("Reload saved link") { draft = value; baseline = value }.font(.caption)
            }
        }.onAppear { draft = value; baseline = value }
            .onChange(of: value) { newValue in
                if draft == baseline || draft == newValue { draft = newValue; baseline = newValue }
            }
    }
    private func commit() {
        guard isValid else { return }
        save(draft, baseline)
    }
}

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    @State private var serverURL = ""
    @State private var serverToken = ""
    @State private var publishing = false
    @State private var cloudEnabled = true
    @State private var monitorLocal = true
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
            Text("Companion settings").font(.title2.bold())
            VStack(alignment: .leading, spacing: 9) {
                Text("Redirect server").font(.headline)
                TextField("https://tap.revivalomaha.org", text: $serverURL).textFieldStyle(.roundedBorder)
                SecureField("Device token · leave blank to keep saved token", text: $serverToken)
                    .textFieldStyle(.roundedBorder)
                Picker("This Mac", selection: $monitorLocal) {
                    Text("Presentation Mac").tag(true)
                    Text("Remote editor").tag(false)
                }.pickerStyle(.segmented)
                    .onChange(of: monitorLocal) { local in if !local { cloudEnabled = true; publishing = false } }
                Toggle("Sync links and presentations with server", isOn: $cloudEnabled).disabled(!monitorLocal)
                Toggle("Publish live destinations", isOn: $publishing).disabled(!monitorLocal)
                HStack {
                    Button("Save server settings") {
                        model.configureServer(url: serverURL, token: serverToken, enabled: publishing, cloudEnabled: cloudEnabled, monitorLocal: monitorLocal)
                        if model.serverError == nil { serverToken = "" }
                    }
                    Text("Token stored in macOS Keychain").font(.caption).foregroundStyle(.secondary)
                }
                if let error = model.serverError { Text(error).font(.caption).foregroundStyle(.red) }
                Text("Use the publish token on the presentation Mac and an editor token on your laptop. Cloud links follow [tap:marker] in Proclaim item titles. The server owns the Church Center fallback.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            VStack(alignment: .leading, spacing: 9) {
                Text("Local Church Center preview").font(.headline)
                Text("Used before connecting a server. Once connected, the preview uses the server's fallback address.")
                    .font(.callout).foregroundStyle(.secondary)
                LinkEditor(value: model.profile.fallbackURL) { value, _ in model.setFallback(value) }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("Connection").font(.headline)
                Text("Run this app on the same Mac as Proclaim. Enable Settings → Remote in Proclaim. The companion starts monitoring when opened and retries automatically.")
                    .font(.callout).foregroundStyle(.secondary)
                Text("Polling: about once per second. Failed requests clear the live preview. Closing the app stops monitoring.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            if model.usesCloud {
                Text(model.cloudMessage).font(.caption)
                if let error = model.cloudEditError ?? model.cloudError { Text(error).font(.caption).foregroundStyle(.red) }
                Button("Import local links for this presentation") { model.importCurrentLocalLinks() }
                    .disabled(model.cloudSaving || !model.cloudFresh || model.isRemoteEditor)
                Text("First add markers to your existing Proclaim items. Import copies their local links to the server and rejects conflicting marker assignments.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("Export local link mappings…") { model.exportProfile() }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }.padding(28)
        }.frame(width: 600, height: 680)
            .onAppear {
                serverURL = model.serverSettings.url; publishing = model.serverSettings.enabled
                cloudEnabled = model.serverSettings.cloudEnabled; monitorLocal = model.serverSettings.monitorLocal
            }
    }
}
