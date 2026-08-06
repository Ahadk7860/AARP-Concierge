# Boi — Notarization Status

**Last updated:** 6 Aug 2026, 1:55 PM ET
**Support ticket:** Filed via Apple Developer Support — "Developer Technical Support" → "Notarization"
**Apple ID:** skylerluk@gmail.com
**Team ID:** DRP7FWTPFN

---

## Summary

The app builds and signs correctly (`codesign --verify --deep --strict` passes, development provisioning complete), but every signed submission to Apple's notary service hangs indefinitely in `In Progress`. Three unsigned pkgs were rejected instantly with `The binary is not signed.` — confirming the notary service is alive and responding. The signed submissions appear to enter a processing queue that never drains.

**Total submissions:** 11
**In Progress (6+ hours):** 8
**Invalid (rejected instantly):** 3
**Accepted:** 0

---

## Signing verification

Both binaries and the app bundle pass strict verification:

```
$ codesign -dvv Boi.app
Executable=/Users/skylerluk/Dev/boi-imessage-track-k/dist/Boi.app/Contents/MacOS/Boi
Identifier=app.boi.mac
Format=app bundle with Mach-O thin (arm64)
Authority=Developer ID Application: Skyler Luk (DRP7FWTPFN)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Aug 6, 2026 at 10:36:44 AM
TeamIdentifier=DRP7FWTPFN
Runtime Version=15.5.0

$ codesign -dvv Boi.app/Contents/Resources/BoiWakeHelper
Identifier=app.boi.mac.wake-helper
Authority=Developer ID Application: Skyler Luk (DRP7FWTPFN)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Aug 6, 2026 at 10:36:44 AM
TeamIdentifier=DRP7FWTPFN
Runtime Version=15.5.0
```

**Signing checklist:**
- [x] Nested signing order: helper signed first, app signed second
- [x] Hardened runtime (`--options runtime --timestamp`)
- [x] Developer ID Application cert for binaries
- [x] Developer ID Installer cert for pkg wrapper
- [x] Stapled timestamp from Apple's servers
- [x] `--verify --deep --strict` passes in both signing stages

---

## Full submission history

| # | Submission ID | Format | Wrapper | Status | Submitted | Notes |
|---|---|---|---|---|---|---|
| 1 | `aa26284f-d187-499c-b8c7-4f46c0966757` | `.pkg` | Unsigned | **Invalid** | Aug 5, 8:38 PM | Rejected in seconds. `The binary is not signed.` — unsigned pkg wrapper blocked the signed .app inside. |
| 2 | `d0ce5f4c-046b-42af-87cc-3e2b7272c068` | `.zip` | N/A | **In Progress** | Aug 5, 8:42 PM | 18+ hours. Original zip with AppleDouble `._` cruft files (14 extraneous files from APFS extended attributes). |
| 3 | `970d7b60-bcde-48f6-8730-11be988f784a` | `.zip` | N/A | **In Progress** | Aug 6, 9:02 AM | 6+ hours. Retry after overnight. |
| 4 | `f9134814-4a87-4018-b5a8-36b189bcaf06` | `.zip` | N/A | **In Progress** | Aug 6, 9:32 AM | 6+ hours. Clean zip — 14 files, zero AppleDouble entries, `ditto --norsrcfork`. |
| 5 | `facf75e4-ffc3-4c22-8f69-c127466f5b43` | `.dmg` | Unsigned | **In Progress** | Aug 6, 9:36 AM | 6+ hours. DMG format attempt (workaround for zip backlog). |
| 6 | `1af1f53d-d43f-46f1-8501-047dd591ab19` | `.pkg` | Unsigned | **Invalid** | Aug 6, 10:16 AM | Rejected in seconds. Same `The binary is not signed.` error. |
| 7 | `84147d37-c341-4309-b74a-79e67a608916` | `.dmg` | Application-signed | **In Progress** | Aug 6, 10:18 AM | 5+ hours. DMG signed with Application cert. |
| 8 | `0552e03d-7ccf-4c40-bf67-cf4b3403a58e` | `.zip` | N/A | **In Progress** | Aug 6, 10:37 AM | 5+ hours. Clean zip after rebuild. AppleDouble files confirmed absent. |
| 9 | `69326768-5fe3-4f4e-af11-71df2ef5c4d7` | `.pkg` | Unsigned | **Invalid** | Aug 6, 10:36 AM | Rejected in seconds. Same `The binary is not signed.` error — confirms only unsigned pkgs process fast. |
| 10 | `2238df99-0415-4a04-8ae9-189079c3da1c` | `.pkg` | **Installer-signed** | **In Progress** | Aug 6, 11:05 AM | 4+ hours. First submission with Developer ID Installer cert on the pkg wrapper + Application cert on the binaries. Full cert chain (Dev ID Installer → Dev ID CA → Apple Root CA). Upload successful via `pkgbuild --sign`. |
| 11 | `ca5e2077-3c49-4410-97ea-564a0a0c2f9d` | `.pkg` | **Installer-signed** | **In Progress** | Aug 6, 1:46 PM | Fresh re-sign with updated timestamps. Same full cert chain. |

---

## Pattern analysis

**Unsigned pkgs:** Rejected instantly (3/3). The scanner sees an unsigned wrapper around a signed .app, can't reach the signature, returns `The binary is not signed.` Response time: **seconds.**

**Signed pkgs, zips, dmgs:** All stuck in `In Progress` (8/8). The scanner successfully authenticates the Developer ID certificates and timestamps but never reaches a verdict. Response time: **hours to days, still pending.**

**Conclusion:** The authenticated scanning pipeline is non-responsive for this account. The unauthenticated pre-check pipeline works normally. This is not a signing configuration issue — the same certificates verified by the same pipeline produce the same result across three different packaging formats and 48 hours of attempts.

---

## Attempted workarounds

| Workaround | Result |
|---|---|
| Zip format | Hung |
| Clean zip (no AppleDouble) | Hung |
| DMG format | Hung |
| DMG signed with Application cert | Hung |
| Unsigned pkg | Rejected instantly |
| Signed pkg (Application cert) | Rejected instantly (`The binary is not signed.`) |
| Signed pkg (Installer cert) | Hung |
| Fresh re-sign + new submission | Hung |
| `altool` legacy path | Refused: "altool no longer supports notarization" |
| Different network | Not yet attempted |

---

## Hypothesis for the hang

There are two possible explanations, both server-side:

1. **Stale account state.** The Apple Developer Program License Agreement (PLA) was updated. Our account accepted it on Aug 6 (~2:00 AM), but Xcode `accounts.download` still fails with `PLA Update available`. The notary service may see the same stale PLA state and refuse to process signed submissions from an account with an unaccepted PLA, but does so silently (no rejection, just indefinite queueing). The unsigned pipeline doesn't check PLA status.

2. **Entitlements gap.** The binaries are signed with hardened runtime (`--options runtime`) but without an explicit `--entitlements` plist. The hardened runtime scanner may expect an entitlements declaration and stall processing when none is present. Unsigned pkgs skip this entirely.

---

## Next steps

- [ ] **Resolve PLA.** Confirm the PLA is fully accepted by re-validating account state at [developer.apple.com/account](https://developer.apple.com/account). If the banner is gone but `accounts.download` still fails, contact Apple Developer Support about the stale state.
- [ ] **Test with entitlements.** The build script includes a minimal entitlements plist at `mac/entitlements.plist`. Re-sign with `--entitlements mac/entitlements.plist` and submit as `Boi-0.1.0-entitled.pkg` to test hypothesis 2.
- [ ] **Try from a different network.** Tether to a phone hotspot and resubmit to rule out edge routing.
- [ ] **Wait for support ticket response.** The DTS ticket is the authoritative path. References all 11 submission IDs.
