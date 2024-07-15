import assert from 'assert';
import logger from './sp_logger.js';
import buffer_utils from './buffer_utils.js';
import uint8array_utils from './uint8array_utils.js';
import mp4parser from './mp4parser.js';

const filePath = import.meta.url;

/**
 * @summary
 * Parse a PSSH box and extract the system IDs.
 */
class pssh {
  /**
   * @param {!Uint8Array} psshBox
   */
  constructor(psshBox) {
    this.systemIds = [];
    this.cencKeyIds = [];
    this.data = [];

    new mp4parser().box('moov', mp4parser.children)
        .fullBox('pssh', (box) => this.parsePsshBox_(box))
        .parse(psshBox);
    
    if (this.data.length == 0) {
      logger.sp_warn(filePath, "No pssh box found!");
    }
  }

  /**
   * @param {!ParsedBox} box
   * @private
   */
  parsePsshBox_(box) {
    assert(box.version != null, 'PSSH boxes are full boxes and must have a valid version');
    assert(box.flags != null, 'PSSH boxes are full boxes and must have a valid flag');
    
    if (box.version > 1) {
      logger.sp_warn(filePath, "Unrecongnized PSSH version found!");
      return;
    }

    // The "reader" gives us a view on the payload of the box.  Create a new
    // view that contains the whole box.
    const dataView = box.reader.getDataView();
    assert(
        dataView.byteOffset >= 12, 'DataView at incorrect position');
    const pssh = buffer_utils.toUint8(dataView, -12, box.size);
    this.data.push(pssh);

    this.systemIds.push(
        uint8array_utils.toHex(box.reader.readBytes(16)));
    if (box.version > 0) {
      const numKeyIds = box.reader.readUint32();
      for (let i = 0; i < numKeyIds; i++) {
        const keyId =
          uint8array_utils.toHex(box.reader.readBytes(16));
        this.cencKeyIds.push(keyId);
      }
    }
  }

  /**
   * Creates a pssh blob from the given system ID, data, keyIds and version.
   *
   * @param {!Uint8Array} data
   * @param {!Uint8Array} systemId
   * @param {!Set.<string>} keyIds
   * @param {number} version
   * @return {!Uint8Array}
   */
   static createPssh(data, systemId, keyIds, version) {
    assert(systemId.byteLength == 16, 'Invalid system ID length');
    const dataLength = data.length;
    let psshSize = 0x4 + 0x4 + 0x4 + systemId.length + 0x4 + dataLength;
    if (version > 0) {
      psshSize += 0x4 + (16 * keyIds.size);
    }

    /** @type {!Uint8Array} */
    const psshBox = new Uint8Array(psshSize);
    /** @type {!DataView} */
    const psshData = buffer_utils.toDataView(psshBox);

    let byteCursor = 0;
    psshData.setUint32(byteCursor, psshSize);
    byteCursor += 0x4;
    psshData.setUint32(byteCursor, 0x70737368);  // 'pssh'
    byteCursor += 0x4;
    (version < 1) ? psshData.setUint32(byteCursor, 0) :
        psshData.setUint32(byteCursor, 0x01000000); // version + flags
    byteCursor += 0x4;
    psshBox.set(systemId, byteCursor);
    byteCursor += systemId.length;

    // if version > 0, add KID count and kid values.
    if (version > 0) {
      psshData.setUint32(byteCursor, keyIds.size); // KID_count
      byteCursor += 0x4;
      for (const keyId of keyIds) {
        const KID = uint8array_utils.fromHex(keyId);
        psshBox.set(KID, byteCursor);
        byteCursor += KID.length;
      }
    }

    psshData.setUint32(byteCursor, dataLength);
    byteCursor += 0x4;
    psshBox.set(data, byteCursor);
    byteCursor += dataLength;

    assert(byteCursor === psshSize, 'PSSH invalid length.');
    return psshBox;
  }


  /**
   * Normalise the initData array. This is to apply browser specific
   * work-arounds, e.g. removing duplicates which appears to occur
   * intermittently when the native msneedkey event fires (i.e. event.initData
   * contains dupes).
   *
   * @param {!Uint8Array} initData
   * @return {!Uint8Array}
   */
  static normaliseInitData(initData) {
    if (!initData) {
      return initData;
    }

    const psshObj = new pssh(initData);

    // If there is only a single pssh, return the original array.
    if (psshObj.data.length <= 1) {
      return initData;
    }

    // Dedupe psshData.
    /** @type {!Array.<!Uint8Array>} */
    const dedupedInitDatas = [];
    for (const initData of psshObj.data) {
      const found = dedupedInitDatas.some((x) => {
        return buffer_utils.equal(x, initData);
      });

      if (!found) {
        dedupedInitDatas.push(initData);
      }
    }

    return uint8array_utils.concat(...dedupedInitDatas);
  }
}

export default pssh;