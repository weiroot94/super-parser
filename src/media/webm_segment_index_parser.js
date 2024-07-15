import assert from 'assert';
import logger from '../util/sp_logger.js';
import { init_segmentReference, segment_reference } from './segment_reference.js';
import { ebml_parser, ebml_element } from '../util/ebml_parser.js';
import error from '../util/error.js';

const filePath = import.meta.url;

class webm_segment_index_parser {
  /**
   * Parses SegmentReferences from a WebM container.
   * @param {BufferSource} cuesData The WebM container's "Cueing Data" section.
   * @param {BufferSource} initData The WebM container's headers.
   * @param {!Array.<string>} uris The possible locations of the WebM file that
   *   contains the segments.
   * @param {init_segmentReference} initSegmentReference
   * @param {number} timestampOffset
   * @param {number} appendWindowStart
   * @param {number} appendWindowEnd
   * @return {!Array.<!segment_reference>}
   * @see http://www.matroska.org/technical/specs/index.html
   * @see http://www.webmproject.org/docs/container/
   */
  static parse(
    cuesData, initData, uris, initSegmentReference, timestampOffset,
    appendWindowStart, appendWindowEnd) {
    const tuple =
      webm_segment_index_parser.parseWebmContainer_(initData);
    const parser = new ebml_parser(cuesData);
    const cuesElement = parser.parseElement();
    if (cuesElement.id != webm_segment_index_parser.CUES_ID) {
      logger.sp_error(filePath, 'Not a Cues element.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_CUES_ELEMENT_MISSING);
    }

    return webm_segment_index_parser.parseCues_(
      cuesElement, tuple.segmentOffset, tuple.timecodeScale, tuple.duration,
      uris, initSegmentReference, timestampOffset, appendWindowStart,
      appendWindowEnd);
  }


  /**
   * Parses a WebM container to get the segment's offset, timecode scale, and
   * duration.
   *
   * @param {BufferSource} initData
   * @return {{segmentOffset: number, timecodeScale: number, duration: number}}
   *   The segment's offset in bytes, the segment's timecode scale in seconds,
   *   and the duration in seconds.
   * @private
   */
  static parseWebmContainer_(initData) {
    const parser = new ebml_parser(initData);

    // Check that the WebM container data starts with the EBML header, but
    // skip its contents.
    const ebmlElement = parser.parseElement();
    if (ebmlElement.id != webm_segment_index_parser.EBML_ID) {
      logger.sp_error(filePath, 'Not an EBML element.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_EBML_HEADER_ELEMENT_MISSING);
    }

    const segmentElement = parser.parseElement();
    if (segmentElement.id != webm_segment_index_parser.SEGMENT_ID) {
      logger.sp_error(filePath, 'Not a Segment element.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_SEGMENT_ELEMENT_MISSING);
    }

    // This value is used as the initial offset to the first referenced segment.
    const segmentOffset = segmentElement.getOffset();

    // Parse the Segment element to get the segment info.
    const segmentInfo = webm_segment_index_parser.parseSegment_(
      segmentElement);
    return {
      segmentOffset: segmentOffset,
      timecodeScale: segmentInfo.timecodeScale,
      duration: segmentInfo.duration,
    };
  }


  /**
   * Parses a WebM Info element to get the segment's timecode scale and
   * duration.
   * @param {!ebml_element} segmentElement
   * @return {{timecodeScale: number, duration: number}} The segment's timecode
   *   scale in seconds and duration in seconds.
   * @private
   */
  static parseSegment_(segmentElement) {
    const parser = segmentElement.createParser();

    // Find the Info element.
    let infoElement = null;
    while (parser.hasMoreData()) {
      const elem = parser.parseElement();
      if (elem.id != webm_segment_index_parser.INFO_ID) {
        continue;
      }

      infoElement = elem;

      break;
    }

    if (!infoElement) {
      logger.sp_error(filePath, 'Not an Info element.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_INFO_ELEMENT_MISSING);
    }

    return webm_segment_index_parser.parseInfo_(infoElement);
  }


  /**
   * Parses a WebM Info element to get the segment's timecode scale and
   * duration.
   * @param {!ebml_element} infoElement
   * @return {{timecodeScale: number, duration: number}} The segment's timecode
   *   scale in seconds and duration in seconds.
   * @private
   */
  static parseInfo_(infoElement) {
    const parser = infoElement.createParser();

    // The timecode scale factor in units of [nanoseconds / T], where [T] are
    // the units used to express all other time values in the WebM container.
    // By default it's assumed that [T] == [milliseconds].
    let timecodeScaleNanoseconds = 1000000;
    /** @type {?number} */
    let durationScale = null;

    while (parser.hasMoreData()) {
      const elem = parser.parseElement();
      if (elem.id == webm_segment_index_parser.TIMECODE_SCALE_ID) {
        timecodeScaleNanoseconds = elem.getUint();
      } else if (elem.id == webm_segment_index_parser.DURATION_ID) {
        durationScale = elem.getFloat();
      }
    }
    if (durationScale == null) {
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_DURATION_ELEMENT_MISSING);
    }

    // The timecode scale factor in units of [seconds / T].
    const timecodeScale = timecodeScaleNanoseconds / 1000000000;
    // The duration is stored in units of [T]
    const durationSeconds = durationScale * timecodeScale;

    return { timecodeScale: timecodeScale, duration: durationSeconds };
  }


  /**
   * Parses a WebM CuesElement.
   * @param {!ebml_element} cuesElement
   * @param {number} segmentOffset
   * @param {number} timecodeScale
   * @param {number} duration
   * @param {!Array.<string>} uris
   * @param {init_segmentReference} initSegmentReference
   * @param {number} timestampOffset
   * @param {number} appendWindowStart
   * @param {number} appendWindowEnd
   * @return {!Array.<!segment_reference>}
   * @private
   */
  static parseCues_(cuesElement, segmentOffset, timecodeScale, duration,
    uris, initSegmentReference, timestampOffset, appendWindowStart,
    appendWindowEnd) {
    const references = [];
    const getUris = () => uris;

    const parser = cuesElement.createParser();

    let lastTime = null;
    let lastOffset = null;

    while (parser.hasMoreData()) {
      const elem = parser.parseElement();
      if (elem.id != webm_segment_index_parser.CUE_POINT_ID) {
        continue;
      }

      const tuple = webm_segment_index_parser.parseCuePoint_(elem);
      if (!tuple) {
        continue;
      }

      // Subtract the presentation time offset from the unscaled time
      const currentTime = timecodeScale * tuple.unscaledTime;
      const currentOffset = segmentOffset + tuple.relativeOffset;

      if (lastTime != null) {
        assert(lastOffset != null, 'last offset cannot be null');

        references.push(
          new segment_reference(
            lastTime + timestampOffset,
            currentTime + timestampOffset,
            getUris,
              /* startByte= */ lastOffset, /* endByte= */ currentOffset - 1,
            initSegmentReference,
            timestampOffset,
            appendWindowStart,
            appendWindowEnd));
      }

      lastTime = currentTime;
      lastOffset = currentOffset;
    }

    if (lastTime != null) {
      assert(lastOffset != null, 'last offset cannot be null');

      references.push(
        new segment_reference(
          lastTime + timestampOffset,
          duration + timestampOffset,
          getUris,
            /* startByte= */ lastOffset, /* endByte= */ null,
          initSegmentReference,
          timestampOffset,
          appendWindowStart,
          appendWindowEnd));
    }

    return references;
  }


  /**
   * Parses a WebM CuePointElement to get an "unadjusted" segment reference.
   * @param {ebml_element} cuePointElement
   * @return {{unscaledTime: number, relativeOffset: number}} The referenced
   *   segment's start time in units of [T] (see parseInfo_()), and the
   *   referenced segment's offset in bytes, relative to a WebM Segment
   *   element.
   * @private
   */
  static parseCuePoint_(cuePointElement) {
    const parser = cuePointElement.createParser();

    // Parse CueTime element.
    const cueTimeElement = parser.parseElement();
    if (cueTimeElement.id != webm_segment_index_parser.CUE_TIME_ID) {
      logger.sp_error(filePath, 'Not a CueTime element.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_CUE_TIME_ELEMENT_MISSING);
    }
    const unscaledTime = cueTimeElement.getUint();

    // Parse CueTrackPositions element.
    const cueTrackPositionsElement = parser.parseElement();
    if (cueTrackPositionsElement.id !=
      webm_segment_index_parser.CUE_TRACK_POSITIONS_ID) {
        logger.sp_error(filePath, 'Not a CueTrackPositions element.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.WEBM_CUE_TRACK_POSITIONS_ELEMENT_MISSING);
    }

    const cueTrackParser = cueTrackPositionsElement.createParser();
    let relativeOffset = 0;

    while (cueTrackParser.hasMoreData()) {
      const elem = cueTrackParser.parseElement();
      if (elem.id != webm_segment_index_parser.CUE_CLUSTER_POSITION) {
        continue;
      }

      relativeOffset = elem.getUint();
      break;
    }

    return { unscaledTime: unscaledTime, relativeOffset: relativeOffset };
  }
}


/** @const {number} */
webm_segment_index_parser.EBML_ID = 0x1a45dfa3;


/** @const {number} */
webm_segment_index_parser.SEGMENT_ID = 0x18538067;


/** @const {number} */
webm_segment_index_parser.INFO_ID = 0x1549a966;


/** @const {number} */
webm_segment_index_parser.TIMECODE_SCALE_ID = 0x2ad7b1;


/** @const {number} */
webm_segment_index_parser.DURATION_ID = 0x4489;


/** @const {number} */
webm_segment_index_parser.CUES_ID = 0x1c53bb6b;


/** @const {number} */
webm_segment_index_parser.CUE_POINT_ID = 0xbb;


/** @const {number} */
webm_segment_index_parser.CUE_TIME_ID = 0xb3;


/** @const {number} */
webm_segment_index_parser.CUE_TRACK_POSITIONS_ID = 0xb7;


/** @const {number} */
webm_segment_index_parser.CUE_CLUSTER_POSITION = 0xf1;

export default webm_segment_index_parser;