import Foundation
import Security

struct ServerSettings: Codable {
    var url = "https://tap.revivalomaha.org"
    var enabled = false
    var cloudEnabled = true
    var monitorLocal = true
    init(url: String = "https://tap.revivalomaha.org", enabled: Bool = false, cloudEnabled: Bool = true, monitorLocal: Bool = true) {
        self.url = url; self.enabled = enabled; self.cloudEnabled = cloudEnabled; self.monitorLocal = monitorLocal
    }
    enum CodingKeys: String, CodingKey { case url, enabled, cloudEnabled, monitorLocal }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = try c.decode(String.self, forKey: .url)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        // Existing installations keep their local mappings until explicitly migrated.
        cloudEnabled = try c.decodeIfPresent(Bool.self, forKey: .cloudEnabled) ?? false
        monitorLocal = try c.decodeIfPresent(Bool.self, forKey: .monitorLocal) ?? true
    }
}

enum TokenStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "org.revivalomaha.proclaim-tap",
         kSecAttrAccount as String: "publish-token"]
    }
    static func load() throws -> String {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Could not read the publish token from Keychain (\(status))."])
        }
        return token
    }
    static func save(_ token: String) throws {
        let data = Data(token.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Could not save the publish token in Keychain (\(status))."])
        }
    }
}
