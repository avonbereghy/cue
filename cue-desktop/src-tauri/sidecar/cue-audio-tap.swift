// cue-audio-tap: Captures system audio via Core Audio Taps (macOS 14.2+)
// Streams mono Float32 PCM to stdout. Logs to stderr. Exits on SIGTERM or stdin close.
// Based on AudioTee's proven pattern: create tap, create empty aggregate device,
// add tap via property, then start IO proc.

import Foundation
import CoreAudio
import AudioToolbox

// MARK: - Globals

var gTapID: AudioObjectID = kAudioObjectUnknown
var gAggregateDeviceID: AudioDeviceID = kAudioObjectUnknown
var gDeviceProcID: AudioDeviceIOProcID?

func log(_ msg: String) {
    FileHandle.standardError.write(Data("[cue-audio-tap] \(msg)\n".utf8))
}

func shutdown(code: Int32 = 0) -> Never {
    if let procID = gDeviceProcID, gAggregateDeviceID != kAudioObjectUnknown {
        AudioDeviceStop(gAggregateDeviceID, procID)
        AudioDeviceDestroyIOProcID(gAggregateDeviceID, procID)
        gDeviceProcID = nil
    }
    if gAggregateDeviceID != kAudioObjectUnknown {
        AudioHardwareDestroyAggregateDevice(gAggregateDeviceID)
        gAggregateDeviceID = kAudioObjectUnknown
    }
    if gTapID != kAudioObjectUnknown {
        AudioHardwareDestroyProcessTap(gTapID)
        gTapID = kAudioObjectUnknown
    }
    exit(code)
}

func getPropertyAddress(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

// MARK: - Main

guard #available(macOS 14.2, *) else {
    log("error: macOS 14.2+ required")
    exit(1)
}

// 1. Create a process tap for all system audio (mono global tap, exclude self)
let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: [])
tapDescription.name = "cue-audio-tap"
tapDescription.isPrivate = true
tapDescription.muteBehavior = .unmuted
tapDescription.isExclusive = false

var tapID: AudioObjectID = kAudioObjectUnknown
var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
guard err == noErr else {
    log("error: AudioHardwareCreateProcessTap failed (OSStatus \(err))")
    exit(1)
}
gTapID = tapID
log("process tap created: \(tapID)")

// Read the tap's UID (needed to attach to aggregate device)
var uidAddress = getPropertyAddress(selector: kAudioTapPropertyUID)
var uidSize = UInt32(MemoryLayout<CFString>.stride)
var tapUID: CFString = "" as CFString
err = withUnsafeMutablePointer(to: &tapUID) { ptr in
    AudioObjectGetPropertyData(tapID, &uidAddress, 0, nil, &uidSize, ptr)
}
guard err == noErr else {
    log("error: could not read tap UID (OSStatus \(err))")
    shutdown(code: 1)
}
log("tap UID: \(tapUID)")

// Read tap format
var fmtAddress = getPropertyAddress(selector: kAudioTapPropertyFormat)
var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
var tapFormat = AudioStreamBasicDescription()
err = AudioObjectGetPropertyData(tapID, &fmtAddress, 0, nil, &fmtSize, &tapFormat)
if err == noErr {
    log("tap format: \(Int(tapFormat.mSampleRate))Hz, \(tapFormat.mChannelsPerFrame)ch, \(tapFormat.mBitsPerChannel)bit")
} else {
    log("warning: could not read tap format (OSStatus \(err))")
}

// 2. Create an empty aggregate device
let aggDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "cue-aggregate-device",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceSubDeviceListKey: [] as CFArray,
    kAudioAggregateDeviceMasterSubDeviceKey: 0,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
]

var aggID: AudioDeviceID = kAudioObjectUnknown
err = AudioHardwareCreateAggregateDevice(aggDescription as CFDictionary, &aggID)
guard err == noErr else {
    log("error: AudioHardwareCreateAggregateDevice failed (OSStatus \(err))")
    shutdown(code: 1)
}
gAggregateDeviceID = aggID
log("aggregate device created: \(aggID)")

// 3. Add the tap to the aggregate device via property
var tapListAddress = getPropertyAddress(selector: kAudioAggregateDevicePropertyTapList)
let tapArray = [tapUID] as CFArray
var tapListSize = UInt32(MemoryLayout<CFArray>.stride)

err = withUnsafePointer(to: tapArray) { ptr in
    AudioObjectSetPropertyData(aggID, &tapListAddress, 0, nil, tapListSize, ptr)
}
guard err == noErr else {
    log("error: failed to add tap to aggregate device (OSStatus \(err))")
    shutdown(code: 1)
}
log("tap attached to aggregate device")

// 4. Create IO proc and start
let ioProcCallback: AudioDeviceIOProc = { device, now, inputData, inputTime, outputData, outputTime, clientData in
    let bufferList = inputData.pointee
    let firstBuffer = bufferList.mBuffers

    guard let sourcePointer = firstBuffer.mData, firstBuffer.mDataByteSize > 0 else {
        return noErr
    }

    let byteCount = Int(firstBuffer.mDataByteSize)
    let data = Data(bytes: sourcePointer, count: byteCount)
    FileHandle.standardOutput.write(data)

    return noErr
}

err = AudioDeviceCreateIOProcID(aggID, ioProcCallback, nil, &gDeviceProcID)
guard err == noErr else {
    log("error: AudioDeviceCreateIOProcID failed (OSStatus \(err))")
    shutdown(code: 1)
}

err = AudioDeviceStart(aggID, gDeviceProcID)
guard err == noErr else {
    log("error: AudioDeviceStart failed (OSStatus \(err))")
    shutdown(code: 1)
}

log("streaming")

// Handle signals
signal(SIGTERM) { _ in shutdown() }
signal(SIGINT) { _ in shutdown() }

// Monitor stdin — if parent dies, stdin closes
DispatchQueue.global().async {
    while true {
        var buf = [UInt8](repeating: 0, count: 64)
        let n = read(STDIN_FILENO, &buf, buf.count)
        if n <= 0 {
            log("stdin closed — shutting down")
            shutdown()
        }
    }
}

dispatchMain()
