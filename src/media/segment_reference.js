import assert from 'assert';
import array_utils from '../util/array_utils.js';

/**
 * Creates an InitSegmentReference, which provides the location to an
 * Initialization segment.
 */
export class init_segmentReference {
  constructor(uris, startByte, endByte, mediaQuality = null) {
    /** @type {function():!Array.<string>} */
    this.getUris = uris;

    /** @const {number} */
    this.startByte = startByte;

    /** @const {?number} */
    this.endByte = endByte;

    /** @const {MediaQualityInfo|null} */
    this.mediaQuality = mediaQuality;
  }
  /**
   * Returns the offset from the start of the resource to the
   * start of the segment.
   *
   * @return {number}
   * @export
   */
  getStartByte() {
    return this.startByte;
  }

  /**
   * Returns the offset from the start of the resource to the end of the
   * segment, inclusive.  A value of null indicates that the segment extends
   * to the end of the resource.
   *
   * @return {?number}
   * @export
   */
  getEndByte() {
    return this.endByte;
  }

  /**
   * Returns the size of the init segment.
   * @return {?number}
   */
  getSize() {
    if (this.endByte) {
      return this.endByte - this.startByte;
    } else {
      return null;
    }
  }

  /**
   * Returns media quality information for the segments associated with
   * this init segment.
   *
   * @return {MediaQualityInfo}
   */
  getMediaQuality() {
    return this.mediaQuality;
  }

  /**
   * Check if two initSegmentReference have all the same values.
   * @param {?init_segmentReference} reference1
   * @param {?init_segmentReference} reference2
   * @return {boolean}
   */
  static equal(reference1, reference2) {
    if (!reference1 || !reference2) {
      return reference1 == reference2;
    } else {
      return reference1.getStartByte() == reference2.getStartByte() &&
        reference1.getEndByte() == reference2.getEndByte() &&
        array_utils.equal(reference1.getUris(), reference2.getUris());
    }
  }
}

export class segment_reference {
  /**
   * @param {number} startTime The segment's start time in seconds.
   * @param {number} endTime The segment's end time in seconds.  The segment
   *   ends the instant before this time, so |endTime| must be strictly greater
   *   than |startTime|.
   * @param {function():!Array.<string>} uris
   *   A function that creates the URIs of the resource containing the segment.
   * @param {number} startByte The offset from the start of the resource to the
   *   start of the segment.
   * @param {?number} endByte The offset from the start of the resource to the
   *   end of the segment, inclusive.  A value of null indicates that the
   *   segment extends to the end of the resource.
   * @param {init_segmentReference} initSegmentReference
   *   The segment's initialization segment metadata, or null if the segments
   *   are self-initializing.
   * @param {number} timestampOffset
   *   The amount of time, in seconds, that must be added to the segment's
   *   internal timestamps to align it to the presentation timeline.
   *   <br>
   *   For DASH, this value should equal the Period start time minus the first
   *   presentation timestamp of the first frame/sample in the Period.  For
   *   example, for MP4 based streams, this value should equal Period start
   *   minus the first segment's tfdt box's 'baseMediaDecodeTime' field (after
   *   it has been converted to seconds).
   *   <br>
   *   For HLS, this value should be 0 to keep the presentation time at the most
   *   recent discontinuity minus the corresponding media time.
   * @param {number} appendWindowStart
   *   The start of the append window for this reference, relative to the
   *   presentation.  Any content from before this time will be removed by
   *   MediaSource.
   * @param {number} appendWindowEnd
   *   The end of the append window for this reference, relative to the
   *   presentation.  Any content from after this time will be removed by
   *   MediaSource.
   * @param {!Array.<!segment_reference>=} partialReferences
   *   A list of SegmentReferences for the partial segments.
   * @param {?string=} tilesLayout
   *   The value is a grid-item-dimension consisting of two positive decimal
   *   integers in the format: column-x-row ('4x3'). It describes the
   *   arrangement of Images in a Grid. The minimum valid LAYOUT is '1x1'.
   * @param {?number=} tileDuration
   *  The explicit duration of an individual tile within the tiles grid.
   *  If not provided, the duration should be automatically calculated based on
   *  the duration of the reference.
   * @param {?number=} syncTime
   *  A time value, expressed in the same scale as the start and end time, which
   *  is used to synchronize between streams.
   */
  constructor(
    startTime, endTime, uris, startByte, endByte, initSegmentReference,
    timestampOffset, appendWindowStart, appendWindowEnd,
    partialReferences = [], tilesLayout = '', tileDuration = null,
    syncTime = null) {
    // A preload hinted Partial Segment has the same startTime and endTime.
    assert(startTime <= endTime,
      'startTime must be less than or equal to endTime');
    assert((endByte == null) || (startByte < endByte),
      'startByte must be < endByte');

    /** @type {number} */
    this.startTime = startTime;

    /** @type {number} */
    this.endTime = endTime;

    /**
     * The "true" end time of the segment, without considering the period end
     * time.  This is necessary for thumbnail segments, where timing requires us
     * to know the original segment duration as described in the manifest.
     * @type {number}
     */
    this.trueEndTime = endTime;

    /** @type {function():!Array.<string>} */
    this.getUrisInner = uris;

    /** @const {number} */
    this.startByte = startByte;

    /** @const {?number} */
    this.endByte = endByte;

    /** @type {init_segmentReference} */
    this.initSegmentReference = initSegmentReference;

    /** @type {number} */
    this.timestampOffset = timestampOffset;

    /** @type {number} */
    this.appendWindowStart = appendWindowStart;

    /** @type {number} */
    this.appendWindowEnd = appendWindowEnd;

    /** @type {!Array.<!segment_reference>} */
    this.partialReferences = partialReferences;

    /** @type {?string} */
    this.tilesLayout = tilesLayout;

    /** @type {?number} */
    this.tileDuration = tileDuration;

    /** @type {?number} */
    this.syncTime = syncTime;
  }

  /**
   * Creates and returns the URIs of the resource containing the segment.
   *
   * @return {!Array.<string>}
   * @export
   */
  getUris() {
    return this.getUrisInner();
  }

  /**
   * Returns the segment's start time in seconds.
   *
   * @return {number}
   * @export
   */
  getStartTime() {
    return this.startTime;
  }

  /**
   * Returns the segment's end time in seconds.
   *
   * @return {number}
   * @export
   */
  getEndTime() {
    return this.endTime;
  }

  /**
   * Returns the offset from the start of the resource to the
   * start of the segment.
   *
   * @return {number}
   * @export
   */
  getStartByte() {
    return this.startByte;
  }

  /**
   * Returns the offset from the start of the resource to the end of the
   * segment, inclusive.  A value of null indicates that the segment extends to
   * the end of the resource.
   *
   * @return {?number}
   * @export
   */
  getEndByte() {
    return this.endByte;
  }

  /**
   * Returns the size of the segment.
   * @return {?number}
   */
  getSize() {
    if (this.endByte) {
      return this.endByte - this.startByte;
    } else {
      return null;
    }
  }

  /**
   * Returns true if it contains partial SegmentReferences.
   * @return {boolean}
   */
  hasPartialSegments() {
    return this.partialReferences.length > 0;
  }

  /**
   * Returns the segment's tiles layout. Only defined in image segments.
   *
   * @return {?string}
   * @export
   */
  getTilesLayout() {
    return this.tilesLayout;
  }

  /**
   * Returns the segment's explicit tile duration.
   * Only defined in image segments.
   *
   * @return {?number}
   * @export
   */
  getTileDuration() {
    return this.tileDuration;
  }
}

/**
 * A convenient typedef for when either type of reference is acceptable.
 *
 * @typedef {init_segmentReference|segment_reference}
 */
 var AnySegmentReference;
