import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: vision-ocr <image>\n".utf8))
    exit(2)
}

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("cannot read image: \(path)\n".utf8))
    exit(1)
}

let width = CGFloat(cgImage.width)
let height = CGFloat(cgImage.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

do {
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    let nodes = (request.results ?? []).compactMap { observation -> [String: Any]? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return [
            "text": candidate.string,
            "confidence": candidate.confidence,
            "bounds": [
                "left": Int(round(box.minX * width)),
                "top": Int(round((1 - box.maxY) * height)),
                "right": Int(round(box.maxX * width)),
                "bottom": Int(round((1 - box.minY) * height)),
            ],
        ]
    }
    let payload: [String: Any] = ["width": Int(width), "height": Int(height), "nodes": nodes]
    let data = try JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("OCR failed: \(error)\n".utf8))
    exit(1)
}
