import Foundation

@main struct VoiceCoreTests {
    static func main() {
        var generation = VoiceGeneration(); let old = generation.advance(); let current = generation.advance()
        let completion = VoiceCompletionGate(); precondition(completion.take() && !completion.take(),"A duplicated terminal audio callback counts only once")
        precondition(!generation.accepts(old) && generation.accepts(current),"Old audio must never regain ownership after interruption")
        var text = VoiceUtteranceBuffer(); text.append("你好，我可以听见你。"); precondition(text.take() == "你好，我可以听见你。")
        text.append("这是尚未结束的半句话"); precondition(text.take() == nil); precondition(text.take(force:true) == "这是尚未结束的半句话")
        var code = VoiceUtteranceBuffer(); code.append("请看屏幕。``"); precondition(code.take() == "请看屏幕。")
        code.append("`swift\nprint(123)\n``"); code.append("`操作完成。"); precondition(code.take() == "操作完成。")
        precondition(code.take(force:true) == nil)
        var transcript = VoiceTranscript()
        transcript.update(start:0,end:1,text:"初稿"); transcript.update(start:0,end:1.2,text:"修正后的话")
        precondition(transcript.text == "修正后的话")
        transcript.commit(through:1.5); transcript.update(start:0,end:1.2,text:"迟到的最终结果")
        precondition(transcript.text.isEmpty,"A late final must not be submitted as a new utterance")
        transcript.update(start:2,end:3,text:"第二句话"); precondition(transcript.text == "第二句话")
        transcript.update(start:Double.nan,end:4,text:"坏时间"); precondition(transcript.text == "第二句话")
        print("PASS: 11 voice ownership, terminal audio, streaming text and transcript boundary checks")
    }
}
