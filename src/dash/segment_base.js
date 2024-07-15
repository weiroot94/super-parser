import assert from 'assert';
import mpd_utils from './mpd_utils.js';
import logger from '../util/sp_logger.js';
import { init_segmentReference } from '../media/segment_reference.js';
import mp4_segment_index_parser from '../media/mp4_segment_index_parser.js';
import { segment_index } from '../media/segment_index.js';
import webm_segment_index_parser from '../media/webm_segment_index_parser.js';
import error from '../util/error.js';
import manifest_parser_utils from '../util/manifest_parser_utils.js';
import xml_utils from '../util/xml_utils.js';
import object_utils from '../util/object_utils.js';

const filePath = import.meta.url;

/**
 * @summary A set of functions for parsing SegmentBase elements.
 */
 class segment_base {
  /**
   * Creates an init segment reference from a Context object.
   *
   * @param {dash_parser.context} context
   * @param {function(?dash_parser.InheritanceFrame):Element} callback
   * @return {init_segmentReference}
   */
  static createInitSegment(context, callback) {
    const MpdUtils = mpd_utils;
    const XmlUtils = xml_utils;
    const ManifestParserUtils = manifest_parser_utils;

    const initialization =
        MpdUtils.inheritChild(context, callback, 'Initialization');
    if (!initialization) {
      return null;
    }

    let resolvedUris = context.representation.baseUris;
    const uri = initialization.getAttribute('sourceURL');
    if (uri) {
      resolvedUris = ManifestParserUtils.resolveUris(
          context.representation.baseUris, [uri]);
    }

    let startByte = 0;
    let endByte = null;
    const range =
        XmlUtils.parseAttr(initialization, 'range', XmlUtils.parseRange);
    if (range) {
      startByte = range.start;
      endByte = range.end;
    }

    const getUris = () => resolvedUris;
    const qualityInfo = segment_base.createQualityInfo(context);
    return new init_segmentReference(
        getUris, startByte, endByte, qualityInfo);
  }

  /**
   * Creates a new StreamInfo object.
   *
   * @param {dash_parser.context} context
   * @param {dash_parser.RequestInitSegmentCallback}
   *     requestInitSegment
   * @return {dash_parser.StreamInfo}
   */
  static createStreamInfo(context, requestInitSegment) {
    assert(context.representation.segmentBase,
        'Should only be called with SegmentBase');
    // Since SegmentBase does not need updates, simply treat any call as
    // the initial parse.
    const MpdUtils = mpd_utils;
    const SegmentBase = segment_base;
    const XmlUtils = xml_utils;

    const unscaledPresentationTimeOffset = Number(MpdUtils.inheritAttribute(
        context, SegmentBase.fromInheritance_, 'presentationTimeOffset')) || 0;

    const timescaleStr = MpdUtils.inheritAttribute(
        context, SegmentBase.fromInheritance_, 'timescale');
    let timescale = 1;
    if (timescaleStr) {
      timescale = XmlUtils.parsePositiveInt(timescaleStr) || 1;
    }

    const scaledPresentationTimeOffset =
        (unscaledPresentationTimeOffset / timescale) || 0;

    const initSegmentReference =
        SegmentBase.createInitSegment(context, SegmentBase.fromInheritance_);

    // Throws an immediate error if the format is unsupported.
    SegmentBase.checkSegmentIndexRangeSupport_(context, initSegmentReference);

    // Direct fields of context will be reassigned by the parser before
    // generateSegmentIndex is called.  So we must make a shallow copy first,
    // and use that in the generateSegmentIndex callbacks.
    const shallowCopyOfContext =
        object_utils.shallowCloneObject(context);

    return {
      generateSegmentIndex: () => {
        return SegmentBase.generateSegmentIndex_(
            shallowCopyOfContext, requestInitSegment, initSegmentReference,
            scaledPresentationTimeOffset);
      },
    };
  }

  /**
   * Creates a SegmentIndex for the given URIs and context.
   *
   * @param {dash_parser.context} context
   * @param {dash_parser.RequestInitSegmentCallback}
   *     requestInitSegment
   * @param {init_segmentReference} initSegmentReference
   * @param {!Array.<string>} uris
   * @param {number} startByte
   * @param {?number} endByte
   * @param {number} scaledPresentationTimeOffset
   * @return {!Promise.<segment_index>}
   */
  static async generateSegmentIndexFromUris(
      context, requestInitSegment, initSegmentReference, uris, startByte,
      endByte, scaledPresentationTimeOffset) {
    // Unpack context right away, before we start an async process.
    // This immunizes us against changes to the context object later.
    /** @type {presentation_timeline} */
    const presentationTimeline = context.presentationTimeline;
    const fitLast = !context.dynamic || !context.periodInfo.isLastPeriod;
    const periodStart = context.periodInfo.start;
    const periodDuration = context.periodInfo.duration;
    const containerType = context.representation.mimeType.split('/')[1];

    // Create a local variable to bind to so we can set to null to help the GC.
    let localRequest = requestInitSegment;
    let segmentIndex = null;

    const responses = [
      localRequest(uris, startByte, endByte),
      containerType == 'webm' ?
          localRequest(
              initSegmentReference.getUris(),
              initSegmentReference.startByte,
              initSegmentReference.endByte) :
          null,
    ];

    localRequest = null;
    const results = await Promise.all(responses);
    const indexData = results[0];
    const initData = results[1] || null;
    /** @type {Array.<!segment_reference>} */
    let references = null;

    const timestampOffset = periodStart - scaledPresentationTimeOffset;
    const appendWindowStart = periodStart;
    const appendWindowEnd = periodDuration ?
        periodStart + periodDuration : Infinity;

    if (containerType == 'mp4') {
      references = mp4_segment_index_parser.parse(
          indexData, startByte, uris, initSegmentReference, timestampOffset,
          appendWindowStart, appendWindowEnd);
    } else {
      assert(initData, 'WebM requires init data');
      references = webm_segment_index_parser.parse(
          indexData, initData, uris, initSegmentReference, timestampOffset,
          appendWindowStart, appendWindowEnd);
    }

    presentationTimeline.notifySegments(references);

    // Since containers are never updated, we don't need to store the
    // segmentIndex in the map.
    assert(!segmentIndex,
        'Should not call generateSegmentIndex twice');

    segmentIndex = new segment_index(references);
    if (fitLast) {
      segmentIndex.fit(appendWindowStart, appendWindowEnd, /* isNew= */ true);
    }
    return segmentIndex;
  }

  /**
   * @param {?dash_parser.InheritanceFrame} frame
   * @return {Element}
   * @private
   */
  static fromInheritance_(frame) {
    return frame.segmentBase;
  }

  /**
   * Compute the byte range of the segment index from the container.
   *
   * @param {dash_parser.context} context
   * @return {?{start: number, end: number}}
   * @private
   */
  static computeIndexRange_(context) {
    const MpdUtils = mpd_utils;
    const SegmentBase = segment_base;
    const XmlUtils = xml_utils;

    const representationIndex = MpdUtils.inheritChild(
        context, SegmentBase.fromInheritance_, 'RepresentationIndex');
    const indexRangeElem = MpdUtils.inheritAttribute(
        context, SegmentBase.fromInheritance_, 'indexRange');

    let indexRange = XmlUtils.parseRange(indexRangeElem || '');
    if (representationIndex) {
      indexRange = XmlUtils.parseAttr(
          representationIndex, 'range', XmlUtils.parseRange, indexRange);
    }
    return indexRange;
  }

  /**
   * Compute the URIs of the segment index from the container.
   *
   * @param {dash_parser.context} context
   * @return {!Array.<string>}
   * @private
   */
  static computeIndexUris_(context) {
    const ManifestParserUtils = manifest_parser_utils;
    const MpdUtils = mpd_utils;
    const SegmentBase = segment_base;

    const representationIndex = MpdUtils.inheritChild(
        context, SegmentBase.fromInheritance_, 'RepresentationIndex');

    let indexUris = context.representation.baseUris;
    if (representationIndex) {
      const representationUri = representationIndex.getAttribute('sourceURL');
      if (representationUri) {
        indexUris = ManifestParserUtils.resolveUris(
            context.representation.baseUris, [representationUri]);
      }
    }

    return indexUris;
  }

  /**
   * Check if this type of segment index is supported.  This allows for
   * immediate errors during parsing, as opposed to an async error from
   * createSegmentIndex().
   *
   * Also checks for a valid byte range, which is not required for callers from
   * SegmentTemplate.
   *
   * @param {dash_parser.context} context
   * @param {init_segmentReference} initSegmentReference
   * @private
   */
  static checkSegmentIndexRangeSupport_(context, initSegmentReference) {
    const SegmentBase = segment_base;

    SegmentBase.checkSegmentIndexSupport(context, initSegmentReference);

    const indexRange = SegmentBase.computeIndexRange_(context);
    if (!indexRange) {
      logger.sp_error(filePath,
          'SegmentBase does not contain sufficient segment information:',
          'the SegmentBase does not contain @indexRange',
          'or a RepresentationIndex element.',
          context.representation);
      throw new error(
          error.Severity.CRITICAL,
          error.Category.MANIFEST,
          error.Code.DASH_NO_SEGMENT_INFO);
    }
  }

  /**
   * Check if this type of segment index is supported.  This allows for
   * immediate errors during parsing, as opposed to an async error from
   * createSegmentIndex().
   *
   * @param {dash_parser.context} context
   * @param {init_segmentReference} initSegmentReference
   */
  static checkSegmentIndexSupport(context, initSegmentReference) {
    const ContentType = manifest_parser_utils.ContentType;

    const contentType = context.representation.contentType;
    const containerType = context.representation.mimeType.split('/')[1];

    if (contentType != ContentType.TEXT && containerType != 'mp4' &&
        containerType != 'webm') {
      logger.sp_error(filePath,
          'SegmentBase specifies an unsupported container type.',
          context.representation);
      throw new error(
          error.Severity.CRITICAL,
          error.Category.MANIFEST,
          error.Code.DASH_UNSUPPORTED_CONTAINER);
    }

    if ((containerType == 'webm') && !initSegmentReference) {
      logger.sp_error(filePath,
          'SegmentBase does not contain sufficient segment information:',
          'the SegmentBase uses a WebM container,',
          'but does not contain an Initialization element.',
          context.representation);
      throw new error(
          error.Severity.CRITICAL,
          error.Category.MANIFEST,
          error.Code.DASH_WEBM_MISSING_INIT);
    }
  }

  /**
   * Generate a SegmentIndex from a Context object.
   *
   * @param {dash_parser.context} context
   * @param {dash_parser.RequestInitSegmentCallback}
   *     requestInitSegment
   * @param {init_segmentReference} initSegmentReference
   * @param {number} scaledPresentationTimeOffset
   * @return {!Promise.<segment_index>}
   * @private
   */
  static generateSegmentIndex_(
      context, requestInitSegment, initSegmentReference,
      scaledPresentationTimeOffset) {
    const SegmentBase = segment_base;

    const indexUris = SegmentBase.computeIndexUris_(context);
    const indexRange = SegmentBase.computeIndexRange_(context);
    assert(indexRange, 'Index range should not be null!');

    return segment_base.generateSegmentIndexFromUris(
        context, requestInitSegment, initSegmentReference, indexUris,
        indexRange.start, indexRange.end,
        scaledPresentationTimeOffset);
  }

  /**
   * Create a MediaQualityInfo object from a Context object.
   *
   * @param {!dash_parser.context} context
   * @return {!MediaQualityInfo}
   */
  static createQualityInfo(context) {
    const representation = context.representation;
    return {
      bandwidth: context.bandwidth,
      audioSamplingRate: representation.audioSamplingRate,
      codecs: representation.codecs,
      contentType: representation.contentType,
      frameRate: representation.frameRate || null,
      height: representation.height || null,
      mimeType: representation.mimeType,
      channelsCount: representation.numChannels,
      pixelAspectRatio: representation.pixelAspectRatio || null,
      width: representation.width || null,
    };
  }
};

export default segment_base;