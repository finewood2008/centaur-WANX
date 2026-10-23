import AppKit
import Foundation

// Only file URLs are read/written. Text is never interpreted as a filesystem path.
do {
    let board = NSPasteboard.general
    let action = CommandLine.arguments.dropFirst().first ?? ""
    var result: [String: Any] = [:]
    if action == "read" {
        let types = board.types ?? []
        let urls = types.contains(.fileURL)
            ? (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []) : []
        result = ["paths": urls.filter { $0.isFileURL }.map { $0.path },
                  "virtual": urls.isEmpty && types.contains { $0.rawValue.contains("filepromise") || $0.rawValue.contains("promised-file") }]
    } else if action == "write" {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let paths = try JSONSerialization.jsonObject(with: input) as? [String], !paths.isEmpty, paths.count <= 20,
              paths.allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else { throw NSError(domain: "clipboard", code: 1) }
        board.clearContents()
        guard board.writeObjects(paths.map { NSURL(fileURLWithPath: $0) }) else { throw NSError(domain: "clipboard", code: 2) }
        result = ["copied": true]
    } else { throw NSError(domain: "clipboard", code: 3) }
    let bytes = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(bytes)
} catch {
    FileHandle.standardError.write(Data("CLIPBOARD_NATIVE_FAILED".utf8))
    exit(1)
}
