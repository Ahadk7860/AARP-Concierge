import BoiKit
import SwiftUI

/// The onboarding window.
///
/// **Every stage renders the same way, from the same three strings.** That is the point:
/// before this, five distinct failures shared one `"Something went wrong"` and the user
/// standing at the cliff edge could not tell which one they were in. The words live in
/// `GrantStage` — in `BoiKit`, where the test suite can read them — and this file is the
/// rendering, not the copy.
struct OnboardingView: View {
    @ObservedObject var model: PermissionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            switch model.stage {
            case .needsConsent:
                ConsentScreen(model: model)
            case .handoff, .ready:
                // **What worked → what to do next → what could be better.** The handoff is
                // the terminal screen and the health findings sit underneath it, rather
                // than the flow ending on a list of two things that are wrong.
                HandoffScreen(model: model, summary: model.summary)
            default:
                StageScreen(model: model, stage: model.stage)
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
            Text(GrantStage.needsConsent.title)
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

/// One screen, driven entirely by the stage.
///
/// The three things every stage carries — what is happening, why, and the one thing to do
/// now — are always on screen. A stage that renders without naming a next step is the
/// spinner this track exists to delete, and `OnboardingTests` refuses to let one exist.
private struct StageScreen: View {
    @ObservedObject var model: PermissionModel
    let stage: GrantStage

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                    .font(.title2)
                    .accessibilityIdentifier("fda-status")
                Text(stage.title)
                    .font(.title2).bold()
                    .accessibilityIdentifier("stage-title")
            }

            Text(stage.body)
                .accessibilityIdentifier("stage-body")

            // THE LIVE STATUS. It flips the moment the toggle flips, because not knowing
            // whether it worked is the single biggest reason people abandon this screen —
            // and the poll count is what proves the app is alive rather than hung.
            if showsLiveStatus {
                HStack(spacing: 10) {
                    Image(systemName: model.accessGranted
                          ? "checkmark.circle.fill" : "circle.dashed")
                        .foregroundStyle(model.accessGranted ? .green : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.accessGranted ? "Full Disk Access granted" : "Not granted yet")
                            .bold()
                        Text(model.statusLine)
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("poll-count")
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
            }

            // The one thing to do now. Never absent on a stage that needs the user.
            if let next = stage.nextStep {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.right.circle.fill")
                        .foregroundStyle(stage.isFailure ? .orange : .accentColor)
                    Text(.init(next)).bold()
                        .accessibilityIdentifier("stage-next-step")
                }
                .padding(.top, 2)
            }

            // Where the copy they opened actually lives — shown rather than described,
            // because "move it to Applications" is advice somebody can follow wrongly.
            if stage == .notInApplications, let path = model.bundlePath {
                Text("Boi is currently running from \(path)")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }

            if stage == .failed, let detail = model.failureDetail {
                Text(detail)
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }

            Spacer()
            HStack {
                if stage.offersSettingsLink {
                    Button("Open Full Disk Access settings") { model.openSettings() }
                        .keyboardShortcut(.defaultAction)
                }
                if stage.offersManualRelaunch {
                    // The exit that does not depend on us detecting anything.
                    Button("Quit and reopen Boi") { model.relaunchManually() }
                }
                if stage == .failed {
                    Button("Try again") { Task { await model.runScan(force: true) } }
                }
                Spacer()
                if stage.offersSettingsLink {
                    Text(FullDiskAccess.settingsDeepLink)
                        .font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
                }
            }
        }
    }

    /// The live probe status belongs on the screens where the user is actively waiting for
    /// it to flip, and nowhere else — on `notInApplications` it would be noise attached to
    /// a switch that cannot help.
    private var showsLiveStatus: Bool {
        switch stage {
        case .waiting, .waitingStalled, .returnedWithoutGranting, .relaunching,
             .relaunchStalled, .deniedAfterRelaunch:
            return true
        case .checking, .needsConsent, .notInApplications, .noDatabase, .syncing,
             .handoff, .ready, .failed:
            return false
        }
    }

    private var icon: String {
        switch stage {
        case .checking, .syncing: return "hourglass"
        case .needsConsent: return "hand.raised.fill"
        case .notInApplications: return "folder.badge.questionmark"
        case .waiting: return "circle.dashed"
        case .waitingStalled, .returnedWithoutGranting: return "questionmark.circle.fill"
        case .handoff, .ready: return "checkmark.circle.fill"
        case .relaunching: return "arrow.clockwise"
        case .relaunchStalled: return "exclamationmark.arrow.circlepath"
        case .deniedAfterRelaunch: return "xmark.circle.fill"
        case .noDatabase: return "tray"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        if stage == .handoff || stage == .ready { return .green }
        return stage.isFailure ? .orange : .secondary
    }
}

/// The terminal screen: the way into the conversation.
///
/// **The setup is over and everything from here happens in Messages**, so the last thing
/// on screen is the door into the thread — not an inventory of what is imperfect. The
/// health findings still ship; they sit below, under their own quieter heading.
private struct HandoffScreen: View {
    @ObservedObject var model: PermissionModel
    let summary: PermissionModel.HealthSummary?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green).font(.title2)
                    Text(model.stage.title).font(.title2).bold()
                        .accessibilityIdentifier("stage-title")
                }

                Text(model.stage.body)

                // ONE MECHANISM, TWO COPY VARIANTS. `sms:` opens an existing conversation
                // or composes a new one, so paired and unpaired differ in what they say
                // and in whether a pairing token rides along — not in machinery.
                // The words are `ThreadHandoff.copy` — in BoiKit, where the suite can read
                // them. This file chooses the layout and nothing else.
                HandoffAction(copy: ThreadHandoff.copy(for: model.handoff),
                              link: model.handoff.link)

                // WHAT COULD BE BETTER — below the handoff, and no longer the last word.
                if let summary, !summary.remedies.isEmpty || !summary.producesReport {
                    Divider().padding(.vertical, 4)
                    Text("A couple of things could make this better")
                        .font(.headline).foregroundStyle(.secondary)

                    // THIN: no report, and it says why. Never hand somebody a bad report
                    // and call it their year in messages.
                    if !summary.producesReport {
                        Text(HealthCheck.thinBody).foregroundStyle(.secondary)
                    }

                    // FIXABLE: every reveal ships with a one-tap remedy. Guilt without
                    // agency is repellent; guilt with a button is a product.
                    ForEach(summary.remedies, id: \.id) { remedy in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(remedy.title).bold()
                            Text(remedy.body).font(.callout).foregroundStyle(.secondary)
                            Text(remedy.fallbackInstructions)
                                .font(.caption).foregroundStyle(.secondary)
                            HStack {
                                if let link = remedy.deepLink, let url = URL(string: link) {
                                    Button("Open settings") { NSWorkspace.shared.open(url) }
                                }
                                if remedy.rescanAvailable {
                                    Button("Scan again") {
                                        Task { await model.runScan(force: true) }
                                    }
                                }
                            }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.4),
                                    in: RoundedRectangle(cornerRadius: 8))
                    }
                }

                if let path = summary?.digestPath {
                    Text("Report written to \(path)")
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Button("Enable background refresh") {
                            model.enableBackgroundRefresh()
                        }
                        Text(ScheduledSync.statusDescription)
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                    }
                    if let degradation = model.backgroundFreshnessDegradation {
                        Label("Background freshness is degraded",
                              systemImage: "exclamationmark.triangle.fill")
                            .font(.callout).foregroundStyle(.orange)
                        Text(degradation)
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("wake-freshness-degraded")
                    }
                    if model.backgroundRefreshRequiresApproval {
                        Button("Open System Settings") {
                            model.openBackgroundApprovalSettings()
                        }
                        .accessibilityIdentifier("wake-helper-open-settings")
                    }
                }
                .padding(.top, 4)
            }
        }
    }
}

/// The door into the thread — or, when there is no link, the plain statement of why not.
///
/// **Never a malformed `sms:` link.** The number is per-user and comes from the registrar;
/// without it there is nothing honest to open, so the button is simply absent rather than
/// pointing at a URL addressed to nothing.
private struct HandoffAction: View {
    let copy: ThreadHandoff.Copy
    let link: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(copy.headline).bold()
            Text(copy.detail).font(.callout).foregroundStyle(.secondary)
            if let button = copy.button, let link {
                Button(button) {
                    if let url = URL(string: link) { NSWorkspace.shared.open(url) }
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("handoff-button")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("handoff-action")
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
