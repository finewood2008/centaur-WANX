// Vector text icon in the same seal style as 知君; no bitmap logo dependency.
// Run on macOS: npm run build:icons. Commit the outputs for Windows builds too.
import AppKit
import CoreText
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let output = root.appendingPathComponent("resources")
let files = FileManager.default
try files.createDirectory(at: output, withIntermediateDirectories: true)
let font = CTFontCreateWithName("STSongti-SC-Bold" as CFString, 1000, nil)
var character: UniChar = 0x4E07 // 万
var glyph: CGGlyph = 0
guard CTFontGetGlyphsForCharacters(font, &character, &glyph, 1),
      let outline = CTFontCreatePathForGlyph(font, glyph, nil) else { fatalError("Cannot render 万") }

func png(_ size: Int, template: Bool = false) -> Data {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    if !template {
        NSColor(srgbRed: 164/255, green: 67/255, blue: 44/255, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 165, yRadius: 165).fill()
        NSColor(srgbRed: 235/255, green: 203/255, blue: 171/255, alpha: 1).setStroke()
        let border = NSBezierPath(roundedRect: NSRect(x: 120, y: 120, width: 784, height: 784), xRadius: 88, yRadius: 88)
        border.lineWidth = 18
        border.stroke()
    }
    let bounds = outline.boundingBoxOfPath
    let scale = (template ? 780.0 : 720.0) / max(bounds.width, bounds.height)
    context.translateBy(x: (1024 - bounds.width * scale) / 2 - bounds.minX * scale,
                        y: (1024 - bounds.height * scale) / 2 - bounds.minY * scale)
    context.scaleBy(x: scale, y: scale)
    context.addPath(outline)
    context.setFillColor((template ? NSColor.black : NSColor(srgbRed: 255/255, green: 249/255, blue: 238/255, alpha: 1)).cgColor)
    context.fillPath()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

try png(1024).write(to: output.appendingPathComponent("icon.png"))
try png(32).write(to: output.appendingPathComponent("tray.png"))
try png(22, template: true).write(to: output.appendingPathComponent("trayTemplate.png"))
try png(44, template: true).write(to: output.appendingPathComponent("trayTemplate@2x.png"))

let temporary = files.temporaryDirectory.appendingPathComponent("wanx-icons-\(UUID().uuidString)")
let iconset = temporary.appendingPathComponent("icon.iconset")
try files.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? files.removeItem(at: temporary) }
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let suffix = scale == 2 ? "@2x" : ""
        try png(pixels).write(
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
let images = sizes.map { png($0) }
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
