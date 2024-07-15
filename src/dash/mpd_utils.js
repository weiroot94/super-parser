import assert from 'assert';
import logger from '../util/sp_logger.js';
import network_engine from '../net/network_engine.js';
import abortable_operation from '../util/abortable_operation.js';
import error from '../util/error.js';
import functional from '../util/functional.js';
import manifest_parser_utils from '../util/manifest_parser_utils.js';
import xml_utils from '../util/xml_utils.js';

const filePath = import.meta.url;

class mpd_utils {
  /**
   * Fills a SegmentTemplate URI template.  This function does not validate the
   * resulting URI.
   *
   * @param {string} uriTemplate
   * @param {?string} representationId
   * @param {?number} number
   * @param {?number} bandwidth
   * @param {?number} time
   * @return {string} A URI string.
   * @see ISO/IEC 23009-1:2014 section 5.3.9.4.4
   */
  static fillUriTemplate(
    uriTemplate, representationId, number, bandwidth, time) {
    /** @type {!Object.<string, ?number|?string>} */
    const valueTable = {
      'RepresentationID': representationId,
      'Number': number,
      'Bandwidth': bandwidth,
      'Time': time,
    };

    const re = /\$(RepresentationID|Number|Bandwidth|Time)?(?:%0([0-9]+)([diouxX]))?\$/g;  // eslint-disable-line max-len
    const uri = uriTemplate.replace(re, (match, name, widthStr, format) => {
      if (match == '$$') {
        return '$';
      }

      let value = valueTable[name];

      // Unrecognized identifier
      assert(value !== undefined, 'Unrecognized identifier');

      // Note that |value| may be 0 or ''.
      if (value == null) {
        logger.sp_warn(filePath,
          'URL template does not have an available substitution for ',
          'identifier "' + name + '":%s',
          uriTemplate);
        return match;
      }

      if (name == 'RepresentationID' && widthStr) {
        logger.sp_warn(filePath,
          'URL template should not contain a width specifier for identifier',
          '"RepresentationID":%s',
          uriTemplate);
        widthStr = undefined;
      }

      if (name == 'Time') {
        assert(typeof value == 'number',
          'Time value should be a number!');
        assert(Math.abs(value - Math.round(value)) < 0.2,
          'Calculated $Time$ values must be close to integers');
        value = Math.round(value);
      }

      /** @type {string} */
      let valueString;
      switch (format) {
        case undefined:  // Happens if there is no format specifier.
        case 'd':
        case 'i':
        case 'u':
          valueString = value.toString();
          break;
        case 'o':
          valueString = value.toString(8);
          break;
        case 'x':
          valueString = value.toString(16);
          break;
        case 'X':
          valueString = value.toString(16).toUpperCase();
          break;
        default:
          valueString = value.toString();
          assert(false, 'Unhandled format specifier');
          break;
      }

      // Create a padding string.
      const width = parseInt(widthStr, 10) || 1;
      const paddingSize = Math.max(0, width - valueString.length);
      const padding = (new Array(paddingSize + 1)).join('0');

      return padding + valueString;
    });

    return uri;
  }

  /**
   * Expands a SegmentTimeline into an array-based timeline.  The results are in
   * seconds.
   *
   * @param {!Element} segmentTimeline
   * @param {number} timescale
   * @param {number} unscaledPresentationTimeOffset
   * @param {number} periodDuration The Period's duration in seconds.
   *   Infinity indicates that the Period continues indefinitely.
   * @return {!Array.<mpd_utils.TimeRange>}
   */
  static createTimeline(
    segmentTimeline, timescale, unscaledPresentationTimeOffset,
    periodDuration) {
    assert(timescale > 0 && timescale < Infinity,
      'timescale must be a positive, finite integer');
    assert(periodDuration > 0, 'period duration must be a positive integer');

    const timePoints = xml_utils.findChildren(segmentTimeline, 'S');

    /** @type {!Array.<mpd_utils.TimeRange>} */
    const timeline = [];
    let lastEndTime = -unscaledPresentationTimeOffset;

    for (let i = 0; i < timePoints.length; ++i) {
      const timePoint = timePoints[i];
      const next = timePoints[i + 1];
      let t = xml_utils.parseAttr(timePoint, 't', xml_utils.parseNonNegativeInt);
      const d =
        xml_utils.parseAttr(timePoint, 'd', xml_utils.parseNonNegativeInt);
      const r = xml_utils.parseAttr(timePoint, 'r', xml_utils.parseInt);

      // Adjust the start time to account for the presentation time offset.
      if (t != null) {
        t -= unscaledPresentationTimeOffset;
      }

      if (!d) {
        logger.sp_warn(filePath,
          '"S" element must have a duration:',
          'ignoring the remaining "S" elements.', timePoint);
        return timeline;
      }

      let startTime = t != null ? t : lastEndTime;

      let repeat = r || 0;
      if (repeat < 0) {
        if (next) {
          const nextStartTime =
            xml_utils.parseAttr(next, 't', xml_utils.parseNonNegativeInt);
          if (nextStartTime == null) {
            logger.sp_warn(filePath,
              'An "S" element cannot have a negative repeat',
              'if the next "S" element does not have a valid start time:',
              'ignoring the remaining "S" elements.', timePoint);
            return timeline;
          } else if (startTime >= nextStartTime) {
            logger.sp_warn(filePath,
              'An "S" element cannot have a negative repeatif its start ',
              'time exceeds the next "S" element\'s start time:',
              'ignoring the remaining "S" elements.', timePoint);
            return timeline;
          }
          repeat = Math.ceil((nextStartTime - startTime) / d) - 1;
        } else {
          if (periodDuration == Infinity) {
            // The DASH spec. actually allows the last "S" element to have a
            // negative repeat value even when the Period has an infinite
            // duration.  No one uses this feature and no one ever should,
            // ever.
            logger.sp_warn(filePath,
              'The last "S" element cannot have a negative repeat',
              'if the Period has an infinite duration:',
              'ignoring the last "S" element.', timePoint);
            return timeline;
          } else if (startTime / timescale >= periodDuration) {
            logger.sp_warn(filePath,
              'The last "S" element cannot have a negative repeat',
              'if its start time exceeds the Period\'s duration:',
              'igoring the last "S" element.', timePoint);
            return timeline;
          }
          repeat = Math.ceil((periodDuration * timescale - startTime) / d) - 1;
        }
      }

      // The end of the last segment may be before the start of the current
      // segment (a gap) or after the start of the current segment (an
      // overlap). If there is a gap/overlap then stretch/compress the end of
      // the last segment to the start of the current segment.
      //
      // Note: it is possible to move the start of the current segment to the
      // end of the last segment, but this would complicate the computation of
      // the $Time$ placeholder later on.
      if ((timeline.length > 0) && (startTime != lastEndTime)) {
        const delta = startTime - lastEndTime;

        if (Math.abs(delta / timescale) >=
          manifest_parser_utils.GAP_OVERLAP_TOLERANCE_SECONDS) {
          logger.sp_warn(filePath,
            'SegmentTimeline contains a large gap/overlap:',
            'the content may have errors in it.', timePoint);
        }

        timeline[timeline.length - 1].end = startTime / timescale;
      }

      for (let j = 0; j <= repeat; ++j) {
        const endTime = startTime + d;
        const item = {
          start: startTime / timescale,
          end: endTime / timescale,
          unscaledStart: startTime,
        };
        timeline.push(item);

        startTime = endTime;
        lastEndTime = endTime;
      }
    }

    return timeline;
  }

  /**
   * Parses common segment info for SegmentList and SegmentTemplate.
   *
   * @param {dash_parser.Context} context
   * @param {function(?dash_parser.InheritanceFrame):Element} callback
   *   Gets the element that contains the segment info.
   * @return {mpd_utils.SegmentInfo}
   */
   static parseSegmentInfo(context, callback) {
    assert(callback(context.representation),
        'There must be at least one element of the given type.');

    const timescaleStr =
        mpd_utils.inheritAttribute(context, callback, 'timescale');
    let timescale = 1;
    if (timescaleStr) {
      timescale = xml_utils.parsePositiveInt(timescaleStr) || 1;
    }

    const durationStr =
        mpd_utils.inheritAttribute(context, callback, 'duration');
    let segmentDuration = xml_utils.parsePositiveInt(durationStr || '');
    const ContentType = manifest_parser_utils.ContentType;
    // TODO: The specification is not clear, check this once it is resolved:
    // https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/404
    if (context.representation.contentType == ContentType.IMAGE) {
      segmentDuration = xml_utils.parseFloat(durationStr || '');
    }
    if (segmentDuration) {
      segmentDuration /= timescale;
    }

    const startNumberStr =
        mpd_utils.inheritAttribute(context, callback, 'startNumber');
    const unscaledPresentationTimeOffset =
        Number(mpd_utils.inheritAttribute(context, callback,
            'presentationTimeOffset')) || 0;
    let startNumber = xml_utils.parseNonNegativeInt(startNumberStr || '');
    if (startNumberStr == null || startNumber == null) {
      startNumber = 1;
    }

    const timelineNode =
        mpd_utils.inheritChild(context, callback, 'SegmentTimeline');
    /** @type {Array.<mpd_utils.TimeRange>} */
    let timeline = null;
    if (timelineNode) {
      timeline = mpd_utils.createTimeline(
          timelineNode, timescale, unscaledPresentationTimeOffset,
          context.periodInfo.duration || Infinity);
    }

    const scaledPresentationTimeOffset =
        (unscaledPresentationTimeOffset / timescale) || 0;
    
    logger.sp_debug(filePath, `Segment Information; timescale: ${timescale}, ` +
      `duration: ${segmentDuration}, startNumber: ${startNumber}, scaledPresentationTimeOffeset: ${scaledPresentationTimeOffset}`);

    return {
      timescale: timescale,
      segmentDuration: segmentDuration,
      startNumber: startNumber,
      scaledPresentationTimeOffset: scaledPresentationTimeOffset,
      unscaledPresentationTimeOffset: unscaledPresentationTimeOffset,
      timeline: timeline,
    };
  }

  /**
   * Searches the inheritance for a Segment* with the given attribute.
   *
   * @param {dash_parser.Context} context
   * @param {function(?dash_parser.InheritanceFrame):Element} callback
   *   Gets the Element that contains the attribute to inherit.
   * @param {string} attribute
   * @return {?string}
   */
   static inheritAttribute(context, callback, attribute) {
    assert(callback(context.representation),
        'There must be at least one element of the given type');

    /** @type {!Array.<!Element>} */
    const nodes = [
      callback(context.representation),
      callback(context.adaptationSet),
      callback(context.period),
    ].filter(functional.isNotNull);

    return nodes
        .map((s) => { return s.getAttribute(attribute); })
        .reduce((all, part) => { return all || part; });
  }

  /**
   * Searches the inheritance for a Segment* with the given child.
   *
   * @param {dash_parser.Context} context
   * @param {function(?dash_parser.InheritanceFrame):Element} callback
   *   Gets the Element that contains the child to inherit.
   * @param {string} child
   * @return {Element}
   */
   static inheritChild(context, callback, child) {
    assert(callback(context.representation),
        'There must be at least one element of the given type');

    /** @type {!Array.<!Element>} */
    const nodes = [
      callback(context.representation),
      callback(context.adaptationSet),
      callback(context.period),
    ].filter(functional.isNotNull);

    return nodes
        .map((s) => { return xml_utils.findChild(s, child); })
        .reduce((all, part) => { return all || part; });
  }

  /**
   * Follow the xlink contained in the given element.
   * It also strips the xlink properties off of the element,
   * even if the process fails.
   * 
   * @param {!Element} element
   * @param {!retry_parameters} retry_parameters
   * @param {boolean} failGracefully
   * @param {string} baseUri
   * @param {network_engine} networkingEngine
   * @param {number} linkDepth
   * @return {!abortable_operation.<!Element>}
   * @private
   */
  static handleXlinkInElement_(
    element, retryParameters, failGracefully, baseUri, networkingEngine, linkDepth
  ) {
    const NS = mpd_utils.XlinkeNamespaceUri_;
    const xlinkHref = xml_utils.getAttributeNS(element, NS, 'href');
    const xlinkActuate = xml_utils.getAttributeNS(element, NS, 'actuate') || 'onRequest';

    // Remove the xlink properties, so it won't be downloaded again
    // when re-processed.
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI == NS) {
        element.removeAttributeNS(attribute.namespaceURI, attribute.localName);
      }
    }

    if (linkDepth >= 5) {
      return new abortable_operation.failed(new error(
        error.Severity.CRITICAL, error.Category.MANIFEST, error.Code.DASH_XLINK_DEPTH_LIMIT
      ));
    }



  }
}

/**
 * @typedef {{
 *   start: number,
 *   unscaledStart: number,
 *   end: number
 * }}
 *
 * @description
 * Defines a time range of a media segment.  Times are in seconds.
 *
 * @property {number} start
 *   The start time of the range.
 * @property {number} unscaledStart
 *   The start time of the range in representation timescale units.
 * @property {number} end
 *   The end time (exclusive) of the range.
 */
mpd_utils.TimeRange;


/**
 * @typedef {{
 *   timescale: number,
 *   segmentDuration: ?number,
 *   startNumber: number,
 *   scaledPresentationTimeOffset: number,
 *   unscaledPresentationTimeOffset: number,
 *   timeline: Array.<mpd_utils.TimeRange>
 * }}
 *
 * @description
 * Contains common information between SegmentList and SegmentTemplate items.
 *
 * @property {number} timescale
 *   The time-scale of the representation.
 * @property {?number} segmentDuration
 *   The duration of the segments in seconds, if given.
 * @property {number} startNumber
 *   The start number of the segments; 1 or greater.
 * @property {number} scaledPresentationTimeOffset
 *   The presentation time offset of the representation, in seconds.
 * @property {number} unscaledPresentationTimeOffset
 *   The presentation time offset of the representation, in timescale units.
 * @property {Array.<mpd_utils.TimeRange>} timeline
 *   The timeline of the representation, if given.  Times in seconds.
 */
mpd_utils.SegmentInfo;


/**
 * @const {string}
 * @private
 */
mpd_utils.XlinkNamespaceUri_ = 'http://www.w3.org/1999/xlink';

export default mpd_utils;