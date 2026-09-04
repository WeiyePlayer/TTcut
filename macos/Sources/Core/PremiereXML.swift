import Foundation

public enum PremiereXML {
  static func escape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&apos;")
  }
  public static func build(video: VideoInfo, clips: [CustomClip], name: String) -> String {
    let rates: [(Double, Int)] = [
      (24000 / 1001, 24), (30000 / 1001, 30), (60000 / 1001, 60), (120000 / 1001, 120),
    ]
    let matched = rates.first { abs($0.0 - video.nominalFPS) / $0.0 < 0.001 }
    let timebase = matched?.1 ?? max(1, Int(video.nominalFPS.rounded()))
    let rate =
      "<rate><timebase>\(timebase)</timebase><ntsc>\(matched == nil ? "FALSE":"TRUE")</ntsc></rate>"
    let sourceDuration = max(1, Int((video.duration * Double(timebase)).rounded()))
    let channels = video.hasAudio ? video.audioChannels : 0
    let stereo = channels == 2
    let characteristics =
      "\(rate)<width>\(video.width)</width><height>\(video.height)</height><pixelaspectratio>square</pixelaspectratio>"
    let audioFormat =
      "<samplecharacteristics><depth>16</depth><samplerate>\(video.audioSampleRate)</samplerate></samplecharacteristics>"
    let layout = channels == 1 ? "<layout>mono</layout>" : stereo ? "<layout>stereo</layout>" : ""
    let channelDescription =
      channels == 1
      ? "<audiochannel><channellabel>mono</channellabel><sourcechannel>1</sourcechannel></audiochannel>"
      : stereo
        ? "<audiochannel><channellabel>left</channellabel><sourcechannel>1</sourcechannel></audiochannel><audiochannel><channellabel>right</channellabel><sourcechannel>2</sourcechannel></audiochannel>"
        : ""
    let sourceAudio =
      channels > 0
      ? "<audio>\(audioFormat)\(layout)<channelcount>\(channels)</channelcount>\(channelDescription)</audio>"
      : ""
    let file =
      "<file id=\"file-1\"><name>\(escape(video.name))</name><pathurl>\(escape(video.url.absoluteString))</pathurl>\(rate)<duration>\(sourceDuration)</duration><media><video><samplecharacteristics>\(characteristics)</samplecharacteristics></video>\(sourceAudio)</media></file>"
    var cursor = 0
    var videoItems = [String]()
    var audioItems = Array(repeating: [String](), count: channels)
    func link(_ id: String, _ type: String, _ track: Int, _ index: Int) -> String {
      "<link><linkclipref>\(id)</linkclipref><mediatype>\(type)</mediatype><trackindex>\(track)</trackindex><clipindex>\(index)</clipindex>\(type=="audio" ? "<groupindex>1</groupindex>":"")</link>"
    }
    for (offset, clip) in clips.enumerated() {
      let input = max(0, min(sourceDuration - 1, Int((clip.start * Double(timebase)).rounded())))
      let output = max(input + 1, min(sourceDuration, Int((clip.end * Double(timebase)).rounded())))
      let count = output - input
      let end = cursor + count
      let videoID = "video-\(offset+1)"
      let audioIDs = (0..<channels).map { "audio-\(offset+1)-\($0+1)" }
      let links =
        channels > 0
        ? link(videoID, "video", 1, offset + 1)
          + audioIDs.enumerated().map { link($0.element, "audio", $0.offset + 1, offset + 1) }
          .joined() : ""
      let title = String(format: "%03d_回合%03d", offset + 1, clip.index)
      let common =
        "<name>\(title)</name><duration>\(count)</duration>\(rate)<start>\(cursor)</start><end>\(end)</end><in>\(input)</in><out>\(output)</out>"
      videoItems.append(
        "<clipitem id=\"\(videoID)\">\(common)\(offset==0 ? file:"<file id=\"file-1\"/>")<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>\(links)</clipitem>"
      )
      for channel in 0..<channels {
        audioItems[channel].append(
          "<clipitem id=\"\(audioIDs[channel])\" premiereChannelType=\"\(stereo ? "stereo":"mono")\">\(common)<file id=\"file-1\"/><sourcetrack><mediatype>audio</mediatype><trackindex>\(channel+1)</trackindex></sourcetrack>\(links)</clipitem>"
        )
      }
      cursor = end
    }
    var audio = ""
    if channels > 0 {
      let outputs = (1...channels).map {
        "<group><index>\($0)</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>\($0)</index></channel></group>"
      }.joined()
      let tracks = audioItems.enumerated().map { index, items in
        let exploded =
          stereo ? " currentExplodedTrackIndex=\"\(index)\" totalExplodedTrackCount=\"2\"" : ""
        return
          "<track\(exploded) premiereTrackType=\"\(stereo ? "Stereo":"Mono")\">\(items.joined())<outputchannelindex>\(index+1)</outputchannelindex></track>"
      }.joined()
      audio =
        "<audio><numOutputChannels>\(channels)</numOutputChannels><format>\(audioFormat)</format><outputs>\(outputs)</outputs>\(tracks)</audio>"
    }
    return
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xmeml version=\"4\"><sequence id=\"sequence-1\"\(stereo ? " explodedTracks=\"true\"":"")><name>\(escape(name))</name><duration>\(cursor)</duration>\(rate)<media><video><format><samplecharacteristics>\(characteristics)</samplecharacteristics></format><track>\(videoItems.joined())</track></video>\(audio)</media></sequence></xmeml>\n"
  }
}
