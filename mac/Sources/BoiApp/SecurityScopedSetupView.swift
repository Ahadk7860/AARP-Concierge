import SwiftUI

/// Three independent grants, each with its own button and its own live status —
/// per HANDOFF_CLAUDE.md's "copy Pally's three-step setup UI." There is no reference
/// implementation of Pally's screen in this repository to copy pixel-for-pixel, so
/// this is a fresh build of the same shape (numbered rows, one per permission, a
/// button, a status indicator that updates in place, and a Refresh that re-probes all
/// three without a relaunch) rather than a port.
struct SecurityScopedSetupView: View {
    @ObservedObject var model: SecurityScopedSetupModel
    /// Called when the user is done here and wants to proceed into the app. Optional
    /// so this view stays usable standalone (previews, tests) — `BoiApp.swift` supplies
    /// it for the real window and uses it to mark setup complete and re-evaluate which
    /// screen comes next.
    var onContinue: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Set Up Boi")
                        .font(.title2).bold()
                    Text("Three separate permissions. Each is independent — granting one "
                         + "does not require the others.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh", action: model.refreshAll)
                    .help("Re-check all three permissions without relaunching Boi.")
            }

            StepRow(number: 1,
                   title: "Messages Folder",
                   detail: "Lets Boi read your message history on this Mac.",
                   status: model.messagesFolderStatus,
                   buttonTitle: "Choose Messages Folder…",
                   action: model.grantMessagesFolderAccess)

            StepRow(number: 2,
                   title: "Contacts",
                   detail: "Lets Boi show names instead of phone numbers.",
                   status: model.contactsStatus,
                   buttonTitle: "Grant Contacts Access",
                   action: model.grantContactsAccess)

            StepRow(number: 3,
                   title: "Automation",
                   detail: "Lets Boi coordinate with Messages in the background.",
                   status: model.automationStatus,
                   buttonTitle: "Grant Automation Access",
                   action: model.grantAutomationAccess)

            Spacer()

            if let onContinue {
                HStack {
                    Spacer()
                    Button("Continue to Boi", action: onContinue)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { model.refreshAll() }
    }
}

private struct StepRow: View {
    let number: Int
    let title: String
    let detail: String
    let status: SecurityScopedSetupModel.StepStatus
    let buttonTitle: String
    let action: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            NumberBadge(number: number)
                .padding(.top, 1)

            StatusIndicator(status: status)
                .padding(.top, 3)

            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
                if case .needsReauthorization(let detail) = status {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Button(buttonTitle, action: action)
                    .disabled(status.isGranted)
                Text(status.label)
                    .font(.caption)
                    .foregroundStyle(status.isGranted ? .green : .secondary)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))
    }
}

/// The step number, shown per row so the three permissions read as an ordered
/// checklist rather than an unordered list of buttons — matching the reference's
/// "three numbered steps."
private struct NumberBadge: View {
    let number: Int

    var body: some View {
        Text("\(number)")
            .font(.caption).bold()
            .frame(width: 18, height: 18)
            .background(Circle().fill(Color.gray.opacity(0.25)))
    }
}

/// The live status indicator every row has, per the spec — a colored dot rather than
/// text alone, so a glance across all three rows tells you what's left without reading.
private struct StatusIndicator: View {
    let status: SecurityScopedSetupModel.StepStatus

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
    }

    private var color: Color {
        switch status {
        case .granted: return .green
        case .checking: return .gray
        case .notGranted: return .secondary.opacity(0.4)
        case .needsReauthorization: return .orange
        }
    }
}
