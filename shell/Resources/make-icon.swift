// Draws the Omniwatch app icon (1024×1024 PNG) with CoreGraphics — headless, no window.
// Usage: make-icon <out.png>. Run via `shell/build.sh icon`, which builds the .icns with sips + iconutil.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

let s = CGFloat(size)
// macOS icon grid: 824 pt body inside 1024 canvas, corner radius ≈ 185.
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let squircle = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)

// Drop shadow + dark gradient body (tokens --ow-surface-2 → --ow-bg).
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.45))
ctx.addPath(squircle); ctx.setFillColor(rgb(0x0f1115)); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(squircle); ctx.clip()
let grad = CGGradient(colorsSpace: cs, colors: [rgb(0x262b36), rgb(0x0f1115)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: s / 2, y: 924), end: CGPoint(x: s / 2, y: 100), options: [])

// Faint "terminal rows" behind the eye.
for (i, w) in [520.0, 380.0, 460.0, 300.0].enumerated() {
    let y = 300.0 + Double(i) * 120
    ctx.setFillColor(rgb(0x8b93a3, 0.10))
    ctx.addPath(CGPath(roundedRect: CGRect(x: 190, y: y, width: w, height: 34), cornerWidth: 17, cornerHeight: 17, transform: nil))
    ctx.fillPath()
}
ctx.restoreGState()

// The waiting glyph ◉ in --ow-attention amber: ring + dot, with a soft glow.
let c = CGPoint(x: s / 2, y: s / 2)
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 60, color: rgb(0xffb020, 0.55))
ctx.setStrokeColor(rgb(0xffb020))
ctx.setLineWidth(58)
ctx.strokeEllipse(in: CGRect(x: c.x - 250, y: c.y - 250, width: 500, height: 500))
ctx.setFillColor(rgb(0xffb020))
ctx.fillEllipse(in: CGRect(x: c.x - 120, y: c.y - 120, width: 240, height: 240))
ctx.restoreGState()
// Highlight on the dot.
ctx.setFillColor(rgb(0xffffff, 0.35))
ctx.fillEllipse(in: CGRect(x: c.x - 60, y: c.y + 20, width: 70, height: 60))

guard let img = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(dest, img, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
