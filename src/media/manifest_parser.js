import logger from '../util/sp_logger.js';
import assert from 'assert';
import error from '../util/error.js';

class manifest_parser {
  /**
   * Registers a manifest parser by file extension.
   *
   * @param {string} extension The file extension of the manifest.
   * @param {Factory} parserFactory The factory
   *   used to create parser instances.
   * @export
   */
   static registerParserByExtension(extension, parserFactory) {
    manifest_parser.parsersByExtension[extension] = parserFactory;
  }


  /**
   * Registers a manifest parser by MIME type.
   *
   * @param {string} mimeType The MIME type of the manifest.
   * @param {Factory} parserFactory The factory
   *   used to create parser instances.
   * @export
   */
  static registerParserByMime(mimeType, parserFactory) {
    manifest_parser.parsersByMime[mimeType] = parserFactory;
  }
}

/**
 * Contains the parser factory functions indexed by MIME type.
 *
 * @type {!Object.<string, Factory>}
 */
manifest_parser.parsersByMime = {};


 /**
  * Contains the parser factory functions indexed by file extension.
  *
  * @type {!Object.<string, Factory>}
  */
manifest_parser.parsersByExtension = {};

export default manifest_parser;