import SwiftUI

/// Three independent grants, each with its own button and its own live status —
/// per HANDOFF_CLAUDE.md's "copy Pally's three-step setup UI." There is no reference
/// implementation of Pally's screen in this repository to copy pixel-for-pixel, so
/// this is a fresh build of the same shape (one row per permission, a button, a status
/// indicator that updates in place) rather than a port.
struct SecurityScopedSetupView: View {
    @ObservedObject var model: SecurityScopedSetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Set Up Boi")
                .font(.title2).bold()

            Text("Three separate permissions. Each is independent — granting one does "
                 + "not require the others.")
                .foregroundStyle(.secondary)

            StepRow(title: "Messages Folder",
                   detail: "Lets Boi read your message history on this Mac.",
                   status: model.messagesFolderStatus,
                   buttonTitle: "Choose Messages Folder…",
                   action: model.grantMessagesFolderAccess)

            StepRow(title: "Contacts",
                   detail: "Lets Boi show names instead of phone numbers.",
                   status: model.contactsStatus,
                   buttonTitle: "Grant Contacts Access",
                   action: model.grantContactsAccess)

            StepRow(title: "Automation",
                   detail: "Lets Boi coordinate with Messages in the background.",
                   status: model.automationStatus,
                   buttonTitle: "Grant Automation Access",
                   action: model.grantAutomationAccess)

            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { model.refreshAll() }
    }
}

private struct StepRow: View {
    let title: String
    let detail: String
    let status: SecurityScopedSetupModel.StepStatus
    let buttonTitle: String
    let action: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
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
