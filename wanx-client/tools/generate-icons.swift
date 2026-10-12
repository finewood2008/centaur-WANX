// Repackage the existing CentaurAI artwork; no new logo or runtime dependency.
// Run on macOS: npm run build:icons. Commit the outputs for Windows builds too.
import AppKit
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let output = root.appendingPathComponent("resources")
let files = FileManager.default
try files.createDirectory(at: output, withIntermediateDirectories: true)
guard let mark = NSImage(contentsOf: root.appendingPathComponent("local-ui/renderer/assets/centaurai-mark.png")) else {
    fatalError("Cannot load the CentaurAI mark")
}

func png(_ size: Int, artwork: Int, template: Bool = false) -> Data {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    NSGraphicsContext.current!.imageInterpolation = .high
    let inset = CGFloat(size - artwork) / 2
    mark.draw(in: NSRect(x: inset, y: inset, width: CGFloat(artwork), height: CGFloat(artwork)), from: .zero, operation: .copy, fraction: 1)
    if template {
        NSColor.black.setFill()
        NSRect(x: 0, y: 0, width: size, height: size).fill(using: .sourceIn)
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

try png(1024, artwork: 824).write(to: output.appendingPathComponent("icon.png"))
try png(32, artwork: 28).write(to: output.appendingPathComponent("tray.png"))
try png(22, artwork: 16, template: true).write(to: output.appendingPathComponent("trayTemplate.png"))
try png(44, artwork: 32, template: true).write(to: output.appendingPathComponent("trayTemplate@2x.png"))

let temporary = files.temporaryDirectory.appendingPathComponent("wanx-icons-\(UUID().uuidString)")
let iconset = temporary.appendingPathComponent("icon.iconset")
try files.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? files.removeItem(at: temporary) }
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let suffix = scale == 2 ? "@2x" : ""
        try png(pixels, artwork: Int(Double(pixels) * 824 / 1024)).write(
            to: iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        )
    }
}
let converter = Process()
converter.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
converter.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("icon.icns").path]
try converter.run()
converter.waitUntilExit()
guard converter.terminationStatus == 0 else { fatalError("ICNS conversion failed") }

// Modern Windows ICO supports PNG entries, preserving alpha at every size.
func le16(_ value: Int) -> Data { var n = UInt16(value).littleEndian; return withUnsafeBytes(of: &n) { Data($0) } }
func le32(_ value: Int) -> Data { var n = UInt32(value).littleEndian; return withUnsafeBytes(of: &n) { Data($0) } }
let sizes = [16, 24, 32, 48, 64, 128, 256]
let images = sizes.map { png($0, artwork: $0) }
var ico = le16(0) + le16(1) + le16(sizes.count)
var offset = 6 + sizes.count * 16
for (size, data) in zip(sizes, images) {
    ico.append(contentsOf: [UInt8(size % 256), UInt8(size % 256), 0, 0])
    ico.append(le16(1) + le16(32) + le32(data.count) + le32(offset))
    offset += data.count
}
for data in images { ico.append(data) }
try ico.write(to: output.appendingPathComponent("icon.ico"))
print("Generated macOS, Windows and tray icons in \(output.path)")
