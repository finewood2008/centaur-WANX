// Package the original CentaurAI mark for each desktop icon surface.
// Run from the repository root: xcrun swift desktop/scripts/generate-brand-icons.swift
import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("dashboard/public/centaurai-mark.png")
guard let mark = NSImage(contentsOf: source) else {
    fatalError("Cannot read the original CentaurAI mark")
}

func writeIcon(_ path: String, canvas: Int, artwork: Int, template: Bool = false) throws {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    bitmap.size = NSSize(width: canvas, height: canvas)
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let inset = CGFloat(canvas - artwork) / 2
    let rect = NSRect(x: inset, y: inset, width: CGFloat(artwork), height: CGFloat(artwork))
    mark.draw(in: rect, from: .zero, operation: .copy, fraction: 1)
    if template {
        // macOS uses the original alpha silhouette and supplies the menu-bar color.
        NSColor.black.setFill()
        NSRect(x: 0, y: 0, width: canvas, height: canvas).fill(using: .sourceIn)
    }
    NSGraphicsContext.restoreGraphicsState()
    let png = bitmap.representation(using: .png, properties: [:])!
    try png.write(to: root.appendingPathComponent(path))
}

try writeIcon("desktop/src/build/appicon.png", canvas: 512, artwork: 512)
try writeIcon("desktop/src/build/appicon-macos.png", canvas: 1024, artwork: 824)
try writeIcon("desktop/src/assets/tray-icon.png", canvas: 88, artwork: 88)
try writeIcon("desktop/src/assets/tray-icon-template.png", canvas: 88, artwork: 64, template: true)
try Data(contentsOf: source).write(to: root.appendingPathComponent("desktop/src/assets/centaurai-mark.png"))
print("Packaged CentaurAI desktop icons from the original mark")
