class mime_utils {
  /**
     * Takes a MIME type and optional codecs string and produces the full MIME
     * type.
     *
     * @param {string} mimeType
     * @param {string=} codecs
     * @return {string}
     * @export
     */
  static getFullType(mimeType, codecs) {
    let fullMimeType = mimeType;
    if (codecs) {
      fullMimeType += '; codecs="' + codecs + '"';
    }
    return fullMimeType;
  }

  /**
   * Get the base codec from a codec string.
   *
   * @param {string} codecString
   * @return {string}
   */
   static getCodecBase(codecString) {
    const parts = mime_utils.getCodecParts_(codecString);
    return parts[0];
  }

  /**
   * Get the base and profile of a codec string. Where [0] will be the codec
   * base and [1] will be the profile.
   * @param {string} codecString
   * @return {!Array.<string>}
   * @private
   */
   static getCodecParts_(codecString) {
    const parts = codecString.split('.');

    const base = parts[0];

    parts.pop();
    const profile = parts.join('.');

    // Make sure that we always return a "base" and "profile".
    return [base, profile];
  }
}

/**
 * A map from Stream object keys to MIME type parameters.  These should be
 * ignored by platforms that do not recognize them.
 *
 * This initial set of parameters are all recognized by Chromecast.
 *
 * @const {!Map.<string, string>}
 * @private
 */
 mime_utils.EXTENDED_MIME_PARAMETERS_ = new Map()
 .set('codecs', 'codecs')
 .set('frameRate', 'framerate')  // Ours is camelCase, theirs is lowercase.
 .set('bandwidth', 'bitrate')  // They are in the same units: bits/sec.
 .set('width', 'width')
 .set('height', 'height')
 .set('channelsCount', 'channels');


/**
* A mimetype created for CEA-608 closed captions.
* @const {string}
*/
mime_utils.CEA608_CLOSED_CAPTION_MIMETYPE = 'application/cea-608';

/**
* A mimetype created for CEA-708 closed captions.
* @const {string}
*/
mime_utils.CEA708_CLOSED_CAPTION_MIMETYPE = 'application/cea-708';

export default mime_utils;