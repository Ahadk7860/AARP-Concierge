import BoiKit
import SwiftUI

/// The onboarding window. Four screens, and the second one is where the funnel bleeds.
struct OnboardingView: View {
    @ObservedObject var model: PermissionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            switch model.step {
            case .checking:
                ProgressView("Checking…")
            case .needsConsent:
                ConsentScreen(model: model)
            case .needsFullDiskAccess, .relaunching:
                FullDiskAccessScreen(model: model)
            case .ready(let summary):
                HealthScreen(model: model, summary: summary)
            case .noDatabase:
                Message(title: "This Mac has no Messages history yet",
                        body: "Boi could not find a Messages database. Open Messages and "
                            + "sign in with your Apple Account, then come back. This is "
                            + "not a permissions problem.")
            case .failed(let detail):
                Message(title: "Something went wrong", body: detail)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// **Names, in plain language, that other people's messages are processed.** Burying that
/// is how a privacy story becomes a betrayal later, and this product's entire claim is
/// that the corpus never moves.
private struct ConsentScreen: View {
    @ObservedObject var model: PermissionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Boi reads your message history on this Mac")
                .font(.title2).bold()

            Text("To tell you who you are drifting from, Boi reads the conversations on "
                 + "this Mac — **including the messages other people sent you.** That "
                 + "reading happens here, on your machine, and nowhere else.")

            VStack(alignment: .leading, spacing: 8) {
                Bullet("Your messages stay on this Mac. They are never uploaded.")
                Bullet("What leaves is counts and dates: how many messages, how recently, "
                       + "how the pace changed. Never the words.")
                Bullet("The one exception is your own writing style, taken from messages "
                       + "**you** sent, with phone numbers, addresses and amounts removed "
                       + "— so drafts sound like you.")
                Bullet("Boi never sends anything for you. You tap send, every time.")
            }
            .padding(.leading, 4)

            Spacer()
            HStack {
                Spacer()
                Button("I understand — continue") { model.acceptConsent() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

/// The screen the whole prompt is about.
private struct FullDiskAccessScreen: View {
    @ObservedObject var model: PermissionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Boi needs Full Disk Access")
                .font(.title2).bold()

            Text("macOS keeps your messages behind a switch that only you can flip. "
                 + "Boi cannot flip it, and no app can.")

            // THE LIVE STATUS. It flips the moment the toggle flips, because not knowing
            // whether it worked is the single biggest reason people abandon this screen.
            HStack(spacing: 10) {
                Image(systemName: model.accessGranted
                      ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(model.accessGranted ? .green : .secondary)
                    .font(.title2)
                    .accessibilityIdentifier("fda-status")
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.accessGranted ? "Full Disk Access granted" : "Not granted yet")
                        .bold()
                    Text(model.statusLine).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 8) {
                Bullet("Click the button below — it opens the exact settings pane.")
                Bullet("Find **Boi** in the list and switch it on.")
                // Said out loud rather than left as a surprise. macOS does not apply a
                // TCC grant to a running process, so the app has to restart. Users who
                // are not told this read the restart as a crash.
                Bullet("Boi will restart itself the moment you do. That is expected — "
                       + "macOS only applies the switch to an app that starts afterwards.")
            }
            .padding(.leading, 4)

            if model.step == .relaunching {
                Label("Restarting Boi…", systemImage: "arrow.clockwise")
                    .foregroundStyle(.green)
            }

            Spacer()
            HStack {
                Button("Open Full Disk Access settings") { model.openSettings() }
                    .keyboardShortcut(.defaultAction)
                Spacer()
                Text(FullDiskAccess.settingsDeepLink)
                    .font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
            }
        }
    }
}

/// Prompt 06's decision, rendered. Three branches, and one of them deliberately produces
/// nothing.
private struct HealthScreen: View {
    @ObservedObject var model: PermissionModel
    let summary: PermissionModel.HealthSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: icon).foregroundStyle(tint).font(.title2)
                Text(title).font(.title2).bold()
            }

            Text(summary.headline)

            // THIN: no report, and it says why. Never hand somebody a bad report and
            // call it their year in messages.
            if !summary.producesReport {
                Text(HealthCheck.thinBody).foregroundStyle(.secondary)
            }

            // FIXABLE: every reveal ships with a one-tap remedy. Guilt without agency is
            // repellent; guilt with a button is a product.
            ForEach(summary.remedies, id: \.id) { remedy in
                VStack(alignment: .leading, spacing: 6) {
                    Text(remedy.title).bold()
                    Text(remedy.body).font(.callout).foregroundStyle(.secondary)
                    Text(remedy.fallbackInstructions).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        if let link = remedy.deepLink, let url = URL(string: link) {
                            Button("Open settings") { NSWorkspace.shared.open(url) }
                        }
                        if remedy.rescanAvailable {
                            Button("Scan again") { Task { await model.runScan(force: true) } }
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }

            if let path = summary.digestPath {
                Text("Report written to \(path)")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }

            Spacer()
            HStack {
                Button("Turn on the daily check") {
                    StructuredLog.emit("agent.register",
                                       fields: ["result": ScheduledSync.register()])
                }
                Text(ScheduledSync.statusDescription)
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Scan now") { Task { await model.runScan(force: true) } }
            }
        }
    }

    private var icon: String {
        switch summary.health {
        case .healthy: return "checkmark.circle.fill"
        case .fixable: return "wrench.adjustable.fill"
        case .thin: return "hourglass"
        }
    }

    private var tint: Color {
        switch summary.health {
        case .healthy: return .green
        case .fixable: return .orange
        case .thin: return .secondary
        }
    }

    private var title: String {
        switch summary.health {
        case .healthy: return "You're all set"
        case .fixable: return "Boi can see more than this"
        case .thin: return "Not enough history yet"
        }
    }
}

private struct Bullet: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
            Text(.init(text))
        }
    }
}

private struct Message: View {
    let title: String
    let detail: String

    init(title: String, body: String) {
        self.title = title
        self.detail = body
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.title2).bold()
            Text(detail).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
}
