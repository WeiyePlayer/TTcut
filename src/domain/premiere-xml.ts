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

function audioLinks(videoId: string, audioId: string, index: number): string {
  return [
    `<link><linkclipref>${audioId}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${index}</clipindex></link>`,
    `<link><linkclipref>${videoId}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${index}</clipindex></link>`,
  ].join('');
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
  const hasAudio = metadata.audio_codec !== null;
  let cursor = 0;
  const videoItems: string[] = [];
  const audioItems: string[] = [];

  for (const [offset, segment] of segments.entries()) {
    const sourceIn = Math.max(0, Math.min(sourceDuration - 1, Math.round(segment.start * rate.timebase)));
    const sourceOut = Math.max(sourceIn + 1, Math.min(sourceDuration, Math.round(segment.end * rate.timebase)));
    const duration = sourceOut - sourceIn;
    const start = cursor;
    const end = start + duration;
    const clipName = escapeXml(`${String(offset + 1).padStart(3, '0')}_回合${String(segment.rallyIndex).padStart(3, '0')}`);
    const videoId = `video-${offset + 1}`;
    const audioId = `audio-${offset + 1}`;
    const sourceAudio = hasAudio
      ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${metadata.audio_sample_rate ?? 48_000}</samplerate></samplecharacteristics></audio>`
      : '';
    const file = offset === 0
      ? `<file id="file-1"><name>${sourceName}</name><pathurl>${sourcePath}</pathurl>${rateXml(rate)}<duration>${sourceDuration}</duration><media><video><samplecharacteristics>${rateXml(rate)}<width>${metadata.width}</width><height>${metadata.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>${sourceAudio}</media></file>`
      : '<file id="file-1"/>';
    const videoLink = hasAudio ? audioLinks(videoId, audioId, offset + 1).split('</link>').at(0)! + '</link>' : '';
    const audioLink = hasAudio ? audioLinks(videoId, audioId, offset + 1).split('</link>').at(1)! + '</link>' : '';
    videoItems.push(`<clipitem id="${videoId}"><name>${clipName}</name><duration>${duration}</duration>${rateXml(rate)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out>${file}${videoLink}</clipitem>`);
    if (hasAudio) {
      audioItems.push(`<clipitem id="${audioId}"><name>${clipName}</name><duration>${duration}</duration>${rateXml(rate)}<start>${start}</start><end>${end}</end><in>${sourceIn}</in><out>${sourceOut}</out><file id="file-1"/>${audioLink}</clipitem>`);
    }
    cursor = end;
  }

  const name = escapeXml(sequenceName);
  const audioTrack = hasAudio ? `<audio><track>${audioItems.join('')}</track></audio>` : '';
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="4"><sequence id="sequence-1"><name>${name}</name><duration>${cursor}</duration>${rateXml(rate)}<media><video><format><samplecharacteristics>${rateXml(rate)}<width>${metadata.width}</width><height>${metadata.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format><track>${videoItems.join('')}</track></video>${audioTrack}</media></sequence></xmeml>\n`,
    quantizedForVfr: metadata.variable_frame_rate,
  };
}
