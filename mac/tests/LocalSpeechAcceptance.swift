import Foundation
import AVFoundation
import Darwin
@available(macOS 26.0, *)
@main struct LocalAudioAcceptance {
 @MainActor static func main() async {
  setbuf(stdout,nil)
  Task {try? await Task.sleep(nanoseconds:60_000_000_000);print("FAIL: local speech fixture timed out");exit(1)}
  do {
   let recognizer=VoiceRecognition(); var text="",failed=false
   recognizer.onText={_,_,value,_ in text=value};recognizer.onError={_ in failed=true}
   let (format,feed)=try await recognizer.prepare();print("Prepared local recognition")
   let synth=AVSpeechSynthesizer(),utterance=AVSpeechUtterance(string:"你好，大肥鱼，请介绍一下自己。")
   utterance.voice=AVSpeechSynthesisVoice(language:"zh-CN");utterance.rate=0.48
   let buffers:[AVAudioPCMBuffer]=await withCheckedContinuation { continuation in
    var captured:[AVAudioPCMBuffer]=[];let gate=VoiceCompletionGate(),lock=NSLock()
    synth.write(utterance){buffer in
     lock.lock();defer{lock.unlock()};guard let pcm=buffer as? AVAudioPCMBuffer else{return}
     if pcm.frameLength==0 {if gate.take(){continuation.resume(returning:captured)}}
     else if let copy=copyVoicePCM(pcm){captured.append(copy)}
    }
   }
   print("Generated PCM buffers=\(buffers.count)")
   let converter=VoicePCMConverter();var duration=0.0,energy=0.0
   for buffer in buffers {
    let converted=try converter.convert(buffer,to:format);duration += Double(converted.frameLength)/format.sampleRate
    if let samples=converted.floatChannelData?[0]{for i in 0..<Int(converted.frameLength){energy += Double(samples[i]*samples[i])}}else if let samples=converted.int16ChannelData?[0]{for i in 0..<Int(converted.frameLength){let x=Double(samples[i])/32768;energy += x*x}}
    feed(converted);try await Task.sleep(nanoseconds:UInt64(Double(converted.frameLength)/format.sampleRate*1_000_000_000))
   }
   for _ in 0..<20 {
    let silence=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(format.sampleRate/10))!;silence.frameLength=silence.frameCapacity
    let list=UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList);for item in list{if let data=item.mData{memset(data,0,Int(item.mDataByteSize))}}
    feed(silence);try await Task.sleep(nanoseconds:100_000_000)
   }
   print("Fed PCM seconds=\(duration) with trailing silence")
   await recognizer.finalize(through:duration)
   print("Finalized recognition")
   let until=Date().addingTimeInterval(8);while text.isEmpty && Date()<until{try await Task.sleep(nanoseconds:100_000_000)}
   recognizer.stop()
   guard !failed,energy>0,!text.isEmpty else{print("FAIL: local ASR/audio fixture did not complete");exit(1)}
   print("PASS: local Chinese TTS PCM and SpeechAnalyzer fixture; seconds=\(duration), recognized_characters=\(text.count), raw_audio_saved=false")
  }catch{print("FAIL: local speech preparation \(error.localizedDescription)");exit(1)}
 }
}
