import assert from 'assert';
import error from './error.js';
import string_utils from './string_utils.js';
import buffer_utils from './buffer_utils.js';

class data_view_reader {
  constructor(data, endianness) {
    this.dataView_ = buffer_utils.toDataView(data);
    this.littleEndian_ =
      endianness == data_view_reader.Endianness.LITTLE_ENDIAN;
    this.position_ = 0;
  }

  getDataView() {
    return this.dataView_;
  }

  hasMoreData() {
    return this.position_ < this.dataView_.byteLength;
  }

  getPosition() {
    return this.position_;
  }

  /**
   * Reads an unsigned 8 bit integer, and advances the reader.
   * @return {number} The integer.
   * @export
   */
  readUint8() {
    try {
      const value = this.dataView_.getUint8(this.position_);
      this.position_ += 1;
      return value;
    } catch(exception) {
      throw this.outOfBounds_();
    }
  }

  /**
   * Reads an unsigned 16 bit integer, and advances the reader.
   * @return {number} The integer.
   * @export
   */
   readUint16() {
    try {
      const value =
          this.dataView_.getUint16(this.position_, this.littleEndian_);
      this.position_ += 2;
      return value;
    } catch (exception) {
      throw this.outOfBounds_();
    }
  }

  /**
   * Reads an unsigned 32 bit integer, and advances the reader.
   * @return {number} The integer.
   * @export
   */
   readUint32() {
    try {
      const value =
          this.dataView_.getUint32(this.position_, this.littleEndian_);
      this.position_ += 4;
      return value;
    } catch (exception) {
      throw this.outOfBounds_();
    }
  }

  /**
   * Reads a signed 32 bit integer, and advances the reader.
   * @return {number} The integer.
   * @export
   */
   readInt32() {
    try {
      const value = this.dataView_.getInt32(this.position_, this.littleEndian_);
      this.position_ += 4;
      return value;
    } catch (exception) {
      throw this.outOfBounds_();
    }
  }

  /**
   * Reads an unsigned 64 bit integer, and advances the reader.
   * @return {number} The integer.
   * @export
   */
   readUint64() {
    /** @type {number} */
    let low;
    /** @type {number} */
    let high;

    try {
      if (this.littleEndian_) {
        low = this.dataView_.getUint32(this.position_, true);
        high = this.dataView_.getUint32(this.position_ + 4, true);
      } else {
        high = this.dataView_.getUint32(this.position_, false);
        low = this.dataView_.getUint32(this.position_ + 4, false);
      }
    } catch (exception) {
      throw this.outOfBounds_();
    }

    if (high > 0x1FFFFF) {
      throw new error(
          error.Severity.CRITICAL,
          error.Category.MEDIA,
          error.Code.JS_INTEGER_OVERFLOW);
    }

    this.position_ += 8;

    // NOTE: This is subtle, but in JavaScript you can't shift left by 32
    // and get the full range of 53-bit values possible.
    // You must multiply by 2^32.
    return (high * Math.pow(2, 32)) + low;
  }

  /**
   * Reads the specified number of raw bytes.
   * @param {number} bytes The number of bytes to read.
   * @return {!Uint8Array}
   * @export
   */
   readBytes(bytes) {
    assert(bytes >= 0, 'Bad call to DataViewReader.readBytes');
    if (this.position_ + bytes > this.dataView_.byteLength) {
      throw this.outOfBounds_();
    }

    const value =
        buffer_utils.toUint8(this.dataView_, this.position_, bytes);
    this.position_ += bytes;
    return value;
  }

  /**
   * Skips the specified number of bytes.
   * @param {number} bytes The number of bytes to skip.
   * @export
   */
   skip(bytes) {
    assert(bytes >= 0, 'Bad call to DataViewReader.skip');
    if (this.position_ + bytes > this.dataView_.byteLength) {
      throw this.outOfBounds_();
    }
    this.position_ += bytes;
  }


  /**
   * Rewinds the specified number of bytes.
   * @param {number} bytes The number of bytes to rewind.
   * @export
   */
  rewind(bytes) {
    assert(bytes >= 0, 'Bad call to DataViewReader.rewind');
    if (this.position_ < bytes) {
      throw this.outOfBounds_();
    }
    this.position_ -= bytes;
  }

  /**
   * Seeks to a specified position.
   * @param {number} position The desired byte position within the DataView.
   * @export
   */
   seek(position) {
    assert(position >= 0, 'Bad call to DataViewReader.seek');
    if (position < 0 || position > this.dataView_.byteLength) {
      throw this.outOfBounds_();
    }
    this.position_ = position;
  }


  /**
   * Keeps reading until it reaches a byte that equals to zero.  The text is
   * assumed to be UTF-8.
   * @return {string}
   * @export
   */
  readTerminatedString() {
    const start = this.position_;
    while (this.hasMoreData()) {
      const value = this.dataView_.getUint8(this.position_);
      if (value == 0) {
        break;
      }
      this.position_ += 1;
    }

    const ret = buffer_utils.toUint8(
        this.dataView_, start, this.position_ - start);
    // Skip string termination.
    this.position_ += 1;
    return string_utils.fromUTF8(ret);
  }


  /**
   * @return {!error}
   * @private
   */
  outOfBounds_() {
    return new error(
        error.Severity.CRITICAL,
        error.Category.MEDIA,
        error.Code.BUFFER_READ_OUT_OF_BOUNDS);
  }
}

data_view_reader.Endianness = {
  'BIG_ENDIAN': 0,
  'LITTLE_ENDIAN': 1,
};

export default data_view_reader;