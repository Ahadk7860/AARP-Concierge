import Foundation

/// Writes JSON where an absent optional becomes `null` rather than a missing key.
///
/// **`JSONEncoder` drops nil optionals, and for these two schemas that is wrong twice
/// over.**
///
/// `voice_pack.v1` lists `contact_id` in `required` *and* permits it to be null — that
/// is how the global fallback pack is spelled — so an omitted key fails validation
/// outright. And `digest.v1`'s `first_contact_at` is optional, so omitting it validates
/// silently, but CONTRACTS.md § 10 says to **emit** `first_contact_at: null` when the
/// corpus is retention-capped. Those are not the same statement to a consumer: a missing
/// key reads as "this build did not compute it", and an explicit null reads as "computed,
/// and the honest answer is that we do not know". The whole point of the rule is the
/// second one. Degrade, never fabricate — but say that you degraded.
///
/// So the keys below are listed explicitly rather than blanket-filled. A blanket rule
/// would spray nulls into every optional the schemas deliberately allow to be absent.
public enum ExplicitNullJSON {

    /// Round-trips through `JSONSerialization` so the result is a plain tree we can
    /// patch, then re-serializes it sorted and pretty-printed.
    public static func data(encoding value: some Encodable,
                            patch: (inout [String: Any]) -> Void) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let encoded = try encoder.encode(value)
        guard var object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        else { return encoded }
        patch(&object)
        return try JSONSerialization.data(withJSONObject: object,
                                          options: [.prettyPrinted, .sortedKeys,
                                                    .withoutEscapingSlashes])
    }

    /// Sets `key` to `null` when it is absent. Present values are never touched.
    public static func fillNull(_ object: inout [String: Any], _ keys: [String]) {
        for key in keys where object[key] == nil { object[key] = NSNull() }
    }
}
