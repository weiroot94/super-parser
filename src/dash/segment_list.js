import assert from 'assert';
import mpd_utils from './mpd_utils.js';
import segment_base from './segment_base.js';
import logger from '../util/sp_logger.js';
import { init_segmentReference, segment_reference } from '../media/segment_reference.js';
import { segment_index } from '../media/segment_index.js';
import error from '../util/error.js';
import functional from '../util/functional.js';
import manifest_parser_utils from '../util/manifest_parser_utils.js';
import xml_utils from '../util/xml_utils.js';

const filePath = import.meta.url;

class segment_list {
  /**
   * Creates a new StreamInfo object.
   * Updates the existing SegmentIndex, if any.
   *
   * @param {dash_parser.Context} context
   * @param {!Object.<string, !Stream>} streamMap
   * @return {dash_parser.StreamInfo}
   */
  static createStreamInfo(context, streamMap) {
    assert(context.representation.segmentList,
      'Should only be called with SegmentList');
    const SegmentList = segment_list;

    const initSegmentReference = segment_base.createInitSegment(
      context, SegmentList.fromInheritance_);
    const info = SegmentList.parseSegmentListInfo_(context);

    SegmentList.checkSegmentListInfo_(context, info);

    /** @type {segment_index} */
    let segmentIndex = null;
    let stream = null;
    if (context.period.id && context.representation.id) {
      // Only check/store the index if period and representation IDs are set.
      const id = context.period.id + ',' + context.representation.id;
      stream = streamMap[id];
      if (stream) {
        segmentIndex = stream.segmentIndex;
      }
    }

    const references = SegmentList.createSegmentReferences_(
      context.periodInfo.start, context.periodInfo.duration,
      info.startNumber, context.representation.baseUris, info,
      initSegmentReference);

    const isNew = !segmentIndex;
    if (segmentIndex) {
      const start = context.presentationTimeline.getSegmentAvailabilityStart();
      segmentIndex.mergeAndEvict(references, start);
    } else {
      segmentIndex = new segment_index(references);
    }
    context.presentationTimeline.notifySegments(references);

    if (!context.dynamic || !context.periodInfo.isLastPeriod) {
      const periodStart = context.periodInfo.start;
      const periodEnd = context.periodInfo.duration ?
        context.periodInfo.start + context.periodInfo.duration : Infinity;
      segmentIndex.fit(periodStart, periodEnd, isNew);
    }

    if (stream) {
      stream.segmentIndex = segmentIndex;
    }

    return {
      generateSegmentIndex: () => {
        if (!segmentIndex || segmentIndex.isEmpty()) {
          segmentIndex.merge(references);
        }
        return Promise.resolve(segmentIndex);
      },
    };
  }

  /**
   * @param {?dash_parser.InheritanceFrame} frame
   * @return {Element}
   * @private
   */
  static fromInheritance_(frame) {
    return frame.segmentList;
  }

  /**
   * Parses the SegmentList items to create an info object.
   *
   * @param {dash_parser.Context} context
   * @return {segment_list.SegmentListInfo}
   * @private
   */
  static parseSegmentListInfo_(context) {
    const SegmentList = segment_list;
    const MpdUtils = mpd_utils;

    const mediaSegments = SegmentList.parseMediaSegments_(context);
    const segmentInfo =
      MpdUtils.parseSegmentInfo(context, SegmentList.fromInheritance_);

    let startNumber = segmentInfo.startNumber;
    if (startNumber == 0) {
      logger.sp_warn(filePath,'SegmentList@startNumber must be > 0');
      startNumber = 1;
    }

    let startTime = 0;
    if (segmentInfo.segmentDuration) {
      // See DASH sec. 5.3.9.5.3
      // Don't use presentationTimeOffset for @duration.
      startTime = segmentInfo.segmentDuration * (startNumber - 1);
    } else if (segmentInfo.timeline && segmentInfo.timeline.length > 0) {
      // The presentationTimeOffset was considered in timeline creation.
      startTime = segmentInfo.timeline[0].start;
    }

    return {
      segmentDuration: segmentInfo.segmentDuration,
      startTime: startTime,
      startNumber: startNumber,
      scaledPresentationTimeOffset: segmentInfo.scaledPresentationTimeOffset,
      timeline: segmentInfo.timeline,
      mediaSegments: mediaSegments,
    };
  }

  /**
   * Checks whether a SegmentListInfo object is valid.
   *
   * @param {dash_parser.Context} context
   * @param {segment_list.SegmentListInfo} info
   * @private
   */
  static checkSegmentListInfo_(context, info) {
    if (!info.segmentDuration && !info.timeline &&
      info.mediaSegments.length > 1) {
      logger.sp_error(filePath,
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList specifies multiple segments,',
        'but does not specify a segment duration or timeline.',
        context.representation);
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MANIFEST,
        error.Code.DASH_NO_SEGMENT_INFO);
    }

    if (!info.segmentDuration && !context.periodInfo.duration &&
      !info.timeline && info.mediaSegments.length == 1) {
      logger.sp_error(filePath,
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList specifies one segment,',
        'but does not specify a segment duration, period duration,',
        'or timeline.',
        context.representation);
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MANIFEST,
        error.Code.DASH_NO_SEGMENT_INFO);
    }

    if (info.timeline && info.timeline.length == 0) {
      logger.sp_error(filePath,
        'SegmentList does not contain sufficient segment information:',
        'the SegmentList has an empty timeline.',
        context.representation);
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MANIFEST,
        error.Code.DASH_NO_SEGMENT_INFO);
    }
  }

  /**
   * Creates an array of segment references for the given data.
   *
   * @param {number} periodStart in seconds.
   * @param {?number} periodDuration in seconds.
   * @param {number} startNumber
   * @param {!Array.<string>} baseUris
   * @param {segment_list.SegmentListInfo} info
   * @param {init_segmentReference} initSegmentReference
   * @return {!Array.<!segment_reference>}
   * @private
   */
  static createSegmentReferences_(
    periodStart, periodDuration, startNumber, baseUris, info,
    initSegmentReference) {
    const ManifestParserUtils = manifest_parser_utils;

    let max = info.mediaSegments.length;
    if (info.timeline && info.timeline.length != info.mediaSegments.length) {
      max = Math.min(info.timeline.length, info.mediaSegments.length);
      logger.sp_warn(filePath,
        'The number of items in the segment timeline and the number of ',
        'segment URLs do not match, truncating', info.mediaSegments.length,
        'to', max);
    }

    const timestampOffset = periodStart - info.scaledPresentationTimeOffset;
    const appendWindowStart = periodStart;
    const appendWindowEnd = periodDuration ?
      periodStart + periodDuration : Infinity;

    /** @type {!Array.<!segment_reference>} */
    const references = [];
    let prevEndTime = info.startTime;
    for (let i = 0; i < max; i++) {
      const segment = info.mediaSegments[i];
      const mediaUri = ManifestParserUtils.resolveUris(
        baseUris, [segment.mediaUri]);

      const startTime = prevEndTime;
      let endTime;

      if (info.segmentDuration != null) {
        endTime = startTime + info.segmentDuration;
      } else if (info.timeline) {
        // Ignore the timepoint start since they are continuous.
        endTime = info.timeline[i].end;
      } else {
        // If segmentDuration and timeline are null then there must
        // be exactly one segment.
        assert(
          info.mediaSegments.length == 1 && periodDuration,
          'There should be exactly one segment with a Period duration.');
        endTime = startTime + periodDuration;
      }

      const getUris = () => mediaUri;
      references.push(
        new segment_reference(
          periodStart + startTime,
          periodStart + endTime,
          getUris,
          segment.start,
          segment.end,
          initSegmentReference,
          timestampOffset,
          appendWindowStart, appendWindowEnd));
      prevEndTime = endTime;
    }

    return references;
  }

  /**
   * Parses the media URIs from the context.
   *
   * @param {dash_parser.Context} context
   * @return {!Array.<segment_list.MediaSegment>}
   * @private
   */
  static parseMediaSegments_(context) {
    const Functional = functional;
    /** @type {!Array.<!Element>} */
    const segmentLists = [
      context.representation.segmentList,
      context.adaptationSet.segmentList,
      context.period.segmentList,
    ].filter(Functional.isNotNull);

    const XmlUtils = xml_utils;
    // Search each SegmentList for one with at least one SegmentURL element,
    // select the first one, and convert each SegmentURL element to a tuple.
    return segmentLists
      .map((node) => { return XmlUtils.findChildren(node, 'SegmentURL'); })
      .reduce((all, part) => { return all.length > 0 ? all : part; })
      .map((urlNode) => {
        if (urlNode.getAttribute('indexRange') &&
          !context.indexRangeWarningGiven) {
          context.indexRangeWarningGiven = true;
          logger.sp_warn(filePath,
            'We do not support the SegmentURL@indexRange attribute on ' +
            'SegmentList.  We only use the SegmentList@duration ' +
            'attribute or SegmentTimeline, which must be accurate.');
        }

        const uri = urlNode.getAttribute('media');
        const range = XmlUtils.parseAttr(
          urlNode, 'mediaRange', XmlUtils.parseRange,
          { start: 0, end: null });
        return { mediaUri: uri, start: range.start, end: range.end };
      });
  }
}

/**
 * @typedef {{
 *   mediaUri: string,
 *   start: number,
 *   end: ?number
 * }}
 *
 * @property {string} mediaUri
 *   The URI of the segment.
 * @property {number} start
 *   The start byte of the segment.
 * @property {?number} end
 *   The end byte of the segment, or null.
 */
segment_list.MediaSegment;

/**
 * @typedef {{
 *   segmentDuration: ?number,
 *   startTime: number,
 *   startNumber: number,
 *   scaledPresentationTimeOffset: number,
 *   timeline: Array.<mpd_utils.TimeRange>,
 *   mediaSegments: !Array.<segment_list.MediaSegment>
 * }}
 * @private
 *
 * @description
 * Contains information about a SegmentList.
 *
 * @property {?number} segmentDuration
 *   The duration of the segments, if given.
 * @property {number} startTime
 *   The start time of the first segment, in seconds.
 * @property {number} startNumber
 *   The start number of the segments; 1 or greater.
 * @property {number} scaledPresentationTimeOffset
 *   The scaledPresentationTimeOffset of the representation, in seconds.
 * @property {Array.<mpd_utils.TimeRange>} timeline
 *   The timeline of the representation, if given.  Times in seconds.
 * @property {!Array.<segment_list.MediaSegment>} mediaSegments
 *   The URI and byte-ranges of the media segments.
 */
segment_list.SegmentListInfo;

export default segment_list;