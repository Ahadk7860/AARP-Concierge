import XCTest
@testable import BoiKit

// Real Security framework calls against the developer's actual login keychain — the
// service string is test-scoped (never the production "app.boi.mac.device-identity")
// and every test cleans up with `store.clear()` in a `defer`, so a crash mid-test is
// the only way a stray item survives. This is a self-write/self-read round trip within
// one unsigned `swift test` process — the concern `TokenStore`'s doc comment raises
// ("an unsigned swift test binary cannot read what the signed app wrote") is about a
// DIFFERENT signing identity reading the item, which nothing here attempts.

final class KeychainTokenStoreTests: XCTestCase {

    func store(_ label: String) -> KeychainTokenStore {
        KeychainTokenStore(service: "app.boi.mac.device-identity.test.\(label)",
                           account: "test-\(UUID().uuidString)")
    }

    func testANeverSavedIdentityReadsAsNilRatherThanCrashing() {
        let store = store("never-saved")
        XCTAssertNil(store.identity())
    }

    func testSaveThenReadRoundTrips() throws {
        let store = store("roundtrip")
        defer { try? store.clear() }
        let identity = DeviceIdentity(user_id: "usr_test_001", device_token: "tok_abcdef")
        try store.save(identity)
        XCTAssertEqual(store.identity(), identity)
    }

    func testSavingTwiceReplacesRatherThanFailing() throws {
        let store = store("replace")
        defer { try? store.clear() }
        try store.save(DeviceIdentity(user_id: "usr_old", device_token: "tok_old"))
        try store.save(DeviceIdentity(user_id: "usr_new", device_token: "tok_new"))
        XCTAssertEqual(store.identity(),
                       DeviceIdentity(user_id: "usr_new", device_token: "tok_new"))
    }

    func testClearRemovesTheSavedIdentity() throws {
        let store = store("clear")
        try store.save(DeviceIdentity(user_id: "usr_x", device_token: "tok_x"))
        try store.clear()
        XCTAssertNil(store.identity())
    }

    func testClearingAnAlreadyEmptyStoreDoesNotThrow() {
        let store = store("clear-empty")
        XCTAssertNoThrow(try store.clear())
    }

    /// Two `KeychainTokenStore` instances with different `service` strings never see
    /// each other's identity — the same isolation `EnvironmentTokenStore`'s
    /// `applicationSupportDirectory` injection exists for, applied to Keychain instead
    /// of a file path. Without this, a bug that hardcoded the service string would make
    /// every paired device on a shared dev machine collide.
    func testDifferentServicesAreIsolatedFromEachOther() throws {
        let storeA = store("isolation-a")
        let storeB = store("isolation-b")
        defer { try? storeA.clear(); try? storeB.clear() }
        try storeA.save(DeviceIdentity(user_id: "usr_a", device_token: "tok_a"))
        XCTAssertNil(storeB.identity())
        XCTAssertEqual(storeA.identity(), DeviceIdentity(user_id: "usr_a", device_token: "tok_a"))
    }
}
