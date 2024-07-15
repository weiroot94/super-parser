import assert from 'assert';
import logger from '../util/sp_logger.js';
import { init_segmentReference, segment_reference } from './segment_reference.js';
import error from '../util/error.js';
import mp4parser from '../util/mp4parser.js';

const filePath = import.meta.url;

class mp4_segment_index_parser {
  /**
     * Parses SegmentReferences from an ISO BMFF SIDX structure.
     * @param {BufferSource} sidxData The MP4's container's SIDX.
     * @param {number} sidxOffset The SIDX's offset, in bytes, from the start of
     *   the MP4 container.
     * @param {!Array.<string>} uris The possible locations of the MP4 file that
     *   contains the segments.
     * @param {init_segmentReference} initSegmentReference
     * @param {number} timestampOffset
     * @param {number} appendWindowStart
     * @param {number} appendWindowEnd
     * @return {!Array.<!segment_reference>}
     */
  static parse(
    sidxData, sidxOffset, uris, initSegmentReference, timestampOffset,
    appendWindowStart, appendWindowEnd) {

    let references;

    const parser = new mp4parser()
      .fullBox('sidx', (box) => {
        references = mp4_segment_index_parser.parseSIDX_(
          sidxOffset,
          initSegmentReference,
          timestampOffset,
          appendWindowStart,
          appendWindowEnd,
          uris,
          box);
      });

    if (sidxData) {
      parser.parse(sidxData);
    }

    if (references) {
      return references;
    } else {
      logger.sp_error(filePath, 'Invalid box type, expected "sidx".');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.MP4_SIDX_WRONG_BOX_TYPE);
    }
  }


  /**
  * Parse a SIDX box from the given reader.
  *
  * @param {number} sidxOffset
  * @param {init_segmentReference} initSegmentReference
  * @param {number} timestampOffset
  * @param {number} appendWindowStart
  * @param {number} appendWindowEnd
  * @param {!Array.<string>} uris The possible locations of the MP4 file that
  *   contains the segments.
  * @param {!ParsedBox} box
  * @return {!Array.<!segment_reference>}
  * @private
  */
  static parseSIDX_(
    sidxOffset, initSegmentReference, timestampOffset, appendWindowStart,
    appendWindowEnd, uris, box) {
    assert(
      box.version != null,
      'SIDX is a full box and should have a valid version.');

    const references = [];

    // Parse the SIDX structure.
    // Skip reference_ID (32 bits).
    box.reader.skip(4);

    const timescale = box.reader.readUint32();

    if (timescale == 0) {
      logger.sp_error(filePath, 'Invalid timescale.');
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.MP4_SIDX_INVALID_TIMESCALE);
    }

    let earliestPresentationTime;
    let firstOffset;

    if (box.version == 0) {
      earliestPresentationTime = box.reader.readUint32();
      firstOffset = box.reader.readUint32();
    } else {
      earliestPresentationTime = box.reader.readUint64();
      firstOffset = box.reader.readUint64();
    }

    // Skip reserved (16 bits).
    box.reader.skip(2);

    // Add references.
    const referenceCount = box.reader.readUint16();

    // Subtract the presentation time offset
    let unscaledStartTime = earliestPresentationTime;
    let startByte = sidxOffset + box.size + firstOffset;

    for (let i = 0; i < referenceCount; i++) {
      // |chunk| is 1 bit for |referenceType|, and 31 bits for |referenceSize|.
      const chunk = box.reader.readUint32();
      const referenceType = (chunk & 0x80000000) >>> 31;
      const referenceSize = chunk & 0x7FFFFFFF;

      const subsegmentDuration = box.reader.readUint32();

      // Skipping 1 bit for |startsWithSap|, 3 bits for |sapType|, and 28 bits
      // for |sapDelta|.
      box.reader.skip(4);

      // If |referenceType| is 1 then the reference is to another SIDX.
      // We do not support this.
      if (referenceType == 1) {
        logger.sp_error(filePath,'[ERROR]Heirarchical SIDXs are not supported.');
        throw new error(
          error.Severity.CRITICAL,
          error.Category.MEDIA,
          error.Code.MP4_SIDX_TYPE_NOT_SUPPORTED);
      }

      // The media timestamps inside the container.
      const nativeStartTime = unscaledStartTime / timescale;
      const nativeEndTime =
        (unscaledStartTime + subsegmentDuration) / timescale;

      references.push(
        new segment_reference(
          nativeStartTime + timestampOffset,
          nativeEndTime + timestampOffset,
          (() => { return uris; }),
          startByte,
          startByte + referenceSize - 1,
          initSegmentReference,
          timestampOffset,
          appendWindowStart,
          appendWindowEnd));

      unscaledStartTime += subsegmentDuration;
      startByte += referenceSize;
    }

    box.parser.stop();
    return references;
  }
}

export default mp4_segment_index_parser;
