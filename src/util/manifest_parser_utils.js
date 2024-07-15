import url from 'url';
import functional from '../util/functional.js';
import error from './error.js';

class manifest_parser_utils {
  /**
   * Resolves an array of relative URIs to the given base URIs. This will result
   * in M*N number of URIs.
   * @param {!Array.<string>} baseUris
   * @param {!Array.<string>} relativeUris
   * @return {!Array.<string>}
   */
  static resolveUris(baseUris, relativeUris) {
    if (relativeUris.length == 0) {
      return baseUris;
    }

    // Resolve each URI relative to each base URI, creating an Array of Arrays.
    // Then flatten the Arrays into a single Array.
    return baseUris
        .map((base) => relativeUris.map((i) => url.resolve(base, i)))
        .reduce(functional.collapseArrays, [])
        .map((uri) => uri.toString());
  }
  
  /**
   * Creates a DrmInfo object from the given info.
   *
   * @param {string} keySystem
   * @param {Array.<extern.InitDataOverride>} initData
   * @return {extern.DrmInfo}
   */
   static createDrmInfo(keySystem, initData) {
    return {
      keySystem: keySystem,
      licenseServerUri: '',
      distinctiveIdentifierRequired: false,
      persistentStateRequired: false,
      audioRobustness: '',
      videoRobustness: '',
      serverCertificate: null,
      serverCertificateUri: '',
      sessionType: '',
      initData: initData || [],
      keyIds: new Set(),
    };
  }

  /**
   * Attempts to guess which codecs from the codecs list belong to a given
   * content type.
   * Assumes that at least one codec is correct, and throws if none are.
   *
   * @param {string} contentType
   * @param {!Array.<string>} codecs
   * @return {string}
   */
   static guessCodecs(contentType, codecs) {
    if (codecs.length == 1) {
      return codecs[0];
    }

    const match = manifest_parser_utils.guessCodecsSafe(
        contentType, codecs);
    // A failure is specifically denoted by null; an empty string represents a
    // valid match of no codec.
    if (match != null) {
      return match;
    }

    // Unable to guess codecs.
    throw new error(
        error.Severity.CRITICAL,
        error.Category.MANIFEST,
        error.Code.HLS_COULD_NOT_GUESS_CODECS,
        codecs);
  }


  /**
   * Attempts to guess which codecs from the codecs list belong to a given
   * content type. Does not assume a single codec is anything special, and does
   * not throw if it fails to match.
   *
   * @param {string} contentType
   * @param {!Array.<string>} codecs
   * @return {?string} or null if no match is found
   */
  static guessCodecsSafe(contentType, codecs) {
    const formats = manifest_parser_utils.CODEC_REGEXPS_BY_CONTENT_TYPE_[contentType];
    for (const format of formats) {
      for (const codec of codecs) {
        if (format.test(codec.trim())) {
          return codec.trim();
        }
      }
    }

    // Text does not require a codec string.
    if (contentType == manifest_parser_utils.ContentType.TEXT) {
      return '';
    }

    return null;
  }
}

/**
 * @enum {string}
 */
 manifest_parser_utils.ContentType = {
  VIDEO: 'video',
  AUDIO: 'audio',
  TEXT: 'text',
  IMAGE: 'image',
  APPLICATION: 'application',
};


/**
 * @enum {string}
 */
manifest_parser_utils.TextStreamKind = {
  SUBTITLE: 'subtitle',
  CLOSED_CAPTION: 'caption',
};


/**
 * Specifies how tolerant the player is of inaccurate segment start times and
 * end times within a manifest. For example, gaps or overlaps between segments
 * in a SegmentTimeline which are greater than or equal to this value will
 * result in a warning message.
 *
 * @const {number}
 */
manifest_parser_utils.GAP_OVERLAP_TOLERANCE_SECONDS = 1 / 15;


/**
 * A list of regexps to detect well-known video codecs.
 *
 * @const {!Array.<!RegExp>}
 * @private
 */
manifest_parser_utils.VIDEO_CODEC_REGEXPS_ = [
  /^avc/,
  /^hev/,
  /^hvc/,
  /^vp0?[89]/,
  /^av1$/,
];


/**
 * A list of regexps to detect well-known audio codecs.
 *
 * @const {!Array.<!RegExp>}
 * @private
 */
manifest_parser_utils.AUDIO_CODEC_REGEXPS_ = [
  /^vorbis$/,
  /^opus$/,
  /^flac$/,
  /^mp4a/,
  /^[ae]c-3$/,
];


/**
 * A list of regexps to detect well-known text codecs.
 *
 * @const {!Array.<!RegExp>}
 * @private
 */
manifest_parser_utils.TEXT_CODEC_REGEXPS_ = [
  /^vtt$/,
  /^wvtt/,
  /^stpp/,
];


/**
 * @const {!Object.<string, !Array.<!RegExp>>}
 */
manifest_parser_utils.CODEC_REGEXPS_BY_CONTENT_TYPE_ = {
  'audio': manifest_parser_utils.AUDIO_CODEC_REGEXPS_,
  'video': manifest_parser_utils.VIDEO_CODEC_REGEXPS_,
  'text': manifest_parser_utils.TEXT_CODEC_REGEXPS_,
};

export default manifest_parser_utils;
