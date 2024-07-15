import logger from '../util/sp_logger.js';
import network_engine from '../net/network_engine.js';
import spEventsMgr from '../util/sp_events_manager.js';

const filePath = import.meta.url;

class widevine_drm_parser {
  constructor(drmInfos) {
    this.widevineInfo_ = this.get_widevine_info_(drmInfos);
    this.keyId_ = "";
    spEventsMgr.on(spEventsMgr.event_manifest_expired, this.onManifestExpired_);
  }

  /**
   * Any manifest can contain multiple DRM configuration, thus
   * find Widevine information and extract it.
   * @param drmInfos drm info collection of manifest
   * @return widevine information
   * @private
   */
  get_widevine_info_(drmInfos) {
    for (const info of drmInfos) {
      if (info.keySystem.includes("widevine")) {
        return info;
      }
    }
    return null;
  }

  clearReference_() {
    this.widevineInfo_ = null;
    this.keyId_ = undefined;
    spEventsMgr.off(spEventsMgr.event_manifest_expired, this.onManifestExpired_);
  }

  onManifestExpired_() {
    this.clearReference_();
  }

  /**
   * get the decryption key with key id
   * 
   * @param apiFormat API format for inputing service type,
   *  id, and pssh-box data
   * @param service service type
   * @param id identifier
   * @return key-pair
   */
  async get_decryption_key(apiFormat, service, id) {
    this.keyId_ = [...this.widevineInfo_.keyIds][0];
    var psshBase64 = this.widevineInfo_.initData[0].rawPssh;
    let keyAPI = apiFormat.replace(/{service}/g, service).replace(/{id}/g, id)
      .replace(/{pssh-box}/g, psshBase64);

    logger.sp_log(filePath, "Fetching decryption key...");
    const decryptionKey = await network_engine.http_get(keyAPI);
    
    if (decryptionKey.status) {
      let key = decryptionKey.keys[this.keyId_];
      if (key == undefined) {
        logger.sp_error(filePath, "Unable to find key data according to given key id.");
        return null;
      } else {
        return key;
      }
    } else {
      logger.sp_error(filePath, "Failed to fetch decryption key...");
      return null;
    }
  }

  get_keyId() {
    return this.keyId_;
  }
}

export default widevine_drm_parser;