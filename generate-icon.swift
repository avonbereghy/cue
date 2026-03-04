#!/usr/bin/env swift
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// --- Background: dark rounded square ---
let corner: CGFloat = size * 0.22
let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
                      xRadius: corner, yRadius: corner)

// Slight vertical gradient for depth
let bgTop = NSColor(calibratedRed: 0.13, green: 0.13, blue: 0.16, alpha: 1.0)
let bgBot = NSColor(calibratedRed: 0.09, green: 0.09, blue: 0.11, alpha: 1.0)
let gradient = NSGradient(starting: bgBot, ending: bgTop)!
gradient.draw(in: bg, angle: 90)

// Subtle inset border
NSColor(calibratedWhite: 0.22, alpha: 0.6).setStroke()
bg.lineWidth = size * 0.008
bg.stroke()

// --- Dot grid ---
let dotR: CGFloat = size * 0.055           // dot radius
let hGap: CGFloat = dotR * 3.2            // horizontal center-to-center
let vGap: CGFloat = dotR * 2.6            // vertical center-to-center
let cols = 2, rows = 4

let gridW = CGFloat(cols - 1) * hGap
let gridH = CGFloat(rows - 1) * vGap
let originX = (size - gridW) / 2
let originY = (size - gridH) / 2

// Colors: white at top → green at bottom
let topColor = (r: 1.0,  g: 1.0,  b: 1.0)    // white
let botColor = (r: 0.25, g: 0.88, b: 0.42)    // systemGreen-ish

for row in 0..<rows {
    let t = CGFloat(row) / CGFloat(rows - 1)   // 0 = top row, 1 = bottom row
    let cr = topColor.r + (botColor.r - topColor.r) * t
    let cg = topColor.g + (botColor.g - topColor.g) * t
    let cb = topColor.b + (botColor.b - topColor.b) * t
    let dotColor = NSColor(calibratedRed: cr, green: cg, blue: cb, alpha: 1.0)

    for col in 0..<cols {
        let cx = originX + CGFloat(col) * hGap
        let cy = originY + CGFloat(rows - 1 - row) * vGap   // flip so row 0 = top

        // Outer glow (large, faint)
        let glow1 = NSRect(x: cx - dotR * 2.2, y: cy - dotR * 2.2,
                           width: dotR * 4.4, height: dotR * 4.4)
        dotColor.withAlphaComponent(0.10).setFill()
        NSBezierPath(ovalIn: glow1).fill()

        // Mid glow
        let glow2 = NSRect(x: cx - dotR * 1.5, y: cy - dotR * 1.5,
                           width: dotR * 3.0, height: dotR * 3.0)
        dotColor.withAlphaComponent(0.22).setFill()
        NSBezierPath(ovalIn: glow2).fill()

        // Core dot
        let dotRect = NSRect(x: cx - dotR, y: cy - dotR,
                             width: dotR * 2, height: dotR * 2)
        dotColor.setFill()
        NSBezierPath(ovalIn: dotRect).fill()

        // Specular highlight (small bright spot, top-left)
        let specR = dotR * 0.35
        let specRect = NSRect(x: cx - dotR * 0.35, y: cy + dotR * 0.15,
                              width: specR * 2, height: specR * 2)
        NSColor.white.withAlphaComponent(0.45).setFill()
        NSBezierPath(ovalIn: specRect).fill()
    }
}

image.unlockFocus()

// --- Save 1024px PNG ---
let tiff = image.tiffRepresentation!
let rep = NSBitmapImageRep(data: tiff)!
let png = rep.representation(using: .png, properties: [:])!
let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/claude-status-icon.png"
try! png.write(to: URL(fileURLWithPath: outPath))
print("Saved \(outPath)")
