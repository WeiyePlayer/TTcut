import { pathToFileURL } from 'node:url';
import type { VideoMetadata } from '../shared/contracts';
import type { ValidatedCustomExportSegment } from './custom-clips';

export type PremiereXmlResult = {
  xml: string;
  quantizedForVfr: boolean;
};

type XmlRate = {
  timebase: number;
  ntsc: boolean;
};

type AudioLayout = {
  channelCount: number;
  premiereTrackType: 'Mono' | 'Stereo';
  premiereChannelType: 'mono' | 'stereo';
  exploded: boolean;
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlRate(metadata: VideoMetadata): XmlRate {
  const fps = metadata.nominal_fps ?? metadata.fps;
  const ntscRates: Array<[number, number]> = [
    [24_000 / 1_001, 24],
    [30_000 / 1_001, 30],
    [60_000 / 1_001, 60],
    [120_000 / 1_001, 120],
  ];
  const matched = ntscRates.find(([candidate]) => Math.abs(candidate - fps) / candidate < 0.001);
  if (matched) return { timebase: matched[1], ntsc: true };
  return { timebase: Math.max(1, Math.round(fps)), ntsc: false };
}

function rateXml(rate: XmlRate): string {
  return `<rate><timebase>${rate.timebase}</timebase><ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
}

function sourceAudioLayout(metadata: VideoMetadata): AudioLayout | null {
  const channels = metadata.audio_channels;
  if (
    metadata.audio_codec === null
    || typeof channels !== 'number'
    || !Number.isSafeInteger(channels)
    || channels < 1
  ) {
    return null;
  }

  const isStereo = channels === 2;
  return {
    channelCount: channels,
    premiereTrackType: isStereo ? 'Stereo' : 'Mono',
    premiereChannelType: isStereo ? 'stereo' : 'mono',
    exploded: isStereo,
  };
}

function sourceAudioXml(metadata: VideoMetadata, audio: AudioLayout): string {
  const layout = audio.channelCount === 1
    ? '<layout>mono</layout>'
    : audio.channelCount === 2
      ? '<layout>stereo</layout>'
      : '';
  const channelDescriptions = audio.channelCount === 1
    ? '<audiochannel><channellabel>mono</channellabel><sourcechannel>1</sourcechannel></audiochannel>'
    : audio.channelCount === 2
      ? '<audiochannel><channellabel>left</channellabel><sourcechannel>1</sourcechannel></audiochannel><audiochannel><channellabel>right</channellabel><sourcechannel>2</sourcechannel></audiochannel>'
      : '';
  return `<audio><samplecharacteristics><depth>16</depth><samplerate>${metadata.audio_sample_rate ?? 48_000}</samplerate></samplecharacteristics>${layout}<channelcount>${audio.channelCount}</channelcount>${channelDescriptions}</audio>`;
}

function linkXml(
  clipId: string,
  mediaType: 'video' | 'audio',
  trackIndex: number,
  clipIndex: number,
  groupIndex?: number,
): string {
  const group = groupIndex === undefined ? '' : `<groupindex>${groupIndex}</groupindex>`;
  return `<link><linkclipref>${clipId}</linkclipref><mediatype>${mediaType}</mediatype><trackindex>${trackIndex}</trackindex><clipindex>${clipIndex}</clipindex>${group}</link>`;
}

function linkedClipItems(videoId: string, audioIds: readonly string[], clipIndex: number): {
  videoLinks: string;
  audioLinks: string;
} {
  const groupedAudioLinks = audioIds.map((audioId, channelIndex) => (
    linkXml(audioId, 'audio', channelIndex + 1, clipIndex, 1)
  ));
  return {
    videoLinks: [
      linkXml(videoId, 'video', 1, clipIndex),
      ...groupedAudioLinks,
    ].join(''),
    audioLinks: [
      linkXml(videoId, 'video', 1, clipIndex),
      ...groupedAudioLinks,
    ].join(''),
  };
}

function sequenceAudioXml(
  metadata: VideoMetadata,
  audio: AudioLayout,
  audioItems: readonly (readonly string[])[],
): string {
  const outputs = audioItems.map((_, channelIndex) => (
    `<group><index>${channelIndex + 1}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>${channelIndex + 1}</index></channel></group>`
  )).join('');
  const tracks = audioItems.map((items, channelIndex) => {
    const explodedAttributes = audio.exploded
      ? ` currentExplodedTrackIndex="${channelIndex}" totalExplodedTrackCount="${audio.channelCount}"`
      : '';
    return `<track${explodedAttributes} premiereTrackType="${audio.premiereTrackType}">${items.join('')}<outputchannelindex>${channelIndex + 1}</outputchannelindex></track>`;
  }).join('');
  return `<audio><numOutputChannels>${audio.channelCount}</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>${metadata.audio_sample_rate ?? 48_000}</samplerate></samplecharacteristics></format><outputs>${outputs}</outputs>${tracks}</audio>`;
}

export function buildPremiereXml(
  metadata: VideoMetadata,
  segments: readonly ValidatedCustomExportSegment[],
  sequenceName: string,
): PremiereXmlResult {
  const rate = xmlRate(metadata);
  const sourceDuration = Math.max(1, Math.round(metadata.duration_seconds * rate.timebase));
  const sourcePath = escapeXml(pathToFileURL(metadata.path).href);
  const sourceName = escapeXml(metadata.path.split(/[\\/]/).at(-1) ?? 'source');
  const audio = sourceAudioLayout(metadata);
  const sourceAudio = audio ? sourceAudioXml(metadata, audio) : '';
  let cursor = 0;
  const videoItems: string[] = [];
  const audioItems = audio ? Array.from({ length: audio.channelCount }, () => [] as string[]) : [];

  for (const [offset, segment] of segments.entries()) {
    const sourceIn = Math.max(0, Math.min(sourceDuration - 1, Math.round(segment.start * rate.timebase)));
    const sourceOut = Math.max(sourceIn + 1, Math.min(sourceDuration, Math.round(segment.end * rate.timebase)));
    const duration = sourceOut - sourceIn;
    const start = cursor;
    const end = start + duration;
    const clipName = escapeXml(`${String(offset + 1).padStart(3, '0')}_回合${String(segment.rallyIndex).padStart(3, '0')}`);
    const videoId = `video-${offset + 1}`;
    const file = offset === 0
      ? `<file id="file-1"><name>${sourceName}</name><pathurl>${sourcePath}</pathurl>${rateXml(rate)}<duration>${sourceDuration}</duration><media><video><samplecharacteristics>${rateXml(rate)}<width>${metadata.width}</width><height>${metadata.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>${sourceAudio}</media></file>`
      : '<file id="file-1"/>';
    const audioIds = audioItems.map((_, channelIndex) => `audio-${offset + 1}-${channelIndex + 1}`);
    const links = audioIds.length > 0 ? linkedClipItems(videoId, audioIds, offset + 1) : null;
    videoItems.push(`<clipitem id="${videoId}"><name>${clipName}</name><duration>${duration}</duration>${rateXml(rate)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out>${file}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>${links?.videoLinks ?? ''}</clipitem>`);
    if (audio) {
      audioItems.forEach((trackItems, channelIndex) => {
        const audioId = audioIds[channelIndex];
        if (!audioId) throw new Error('Audio track id was not generated.');
        trackItems.push(`<clipitem id="${audioId}" premiereChannelType="${audio.premiereChannelType}"><name>${clipName}</name><duration>${duration}</duration>${rateXml(rate)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out><file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>${channelIndex + 1}</trackindex></sourcetrack>${links?.audioLinks ?? ''}</clipitem>`);
      });
    }
    cursor = end;
  }

  const name = escapeXml(sequenceName);
  const audioTracks = audio ? sequenceAudioXml(metadata, audio, audioItems) : '';
  const sequenceAttributes = audio?.exploded ? ' explodedTracks="true"' : '';
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="4"><sequence id="sequence-1"${sequenceAttributes}><name>${name}</name><duration>${cursor}</duration>${rateXml(rate)}<media><video><format><samplecharacteristics>${rateXml(rate)}<width>${metadata.width}</width><height>${metadata.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format><track>${videoItems.join('')}</track></video>${audioTracks}</media></sequence></xmeml>\n`,
    quantizedForVfr: metadata.variable_frame_rate,
  };
}
