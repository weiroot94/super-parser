class drm_engine {
  /**
     * Checks if two DrmInfos can be decrypted using the same key system.
     * Clear content is considered compatible with every key system.
     *
     * @param {!Array.<!DrmInfo>} drms1
     * @param {!Array.<!DrmInfo>} drms2
     * @return {boolean}
     */
  static areDrmCompatible(drms1, drms2) {
    if (!drms1.length || !drms2.length) {
      return true;
    }

    return drm_engine.getCommonDrmInfos(
      drms1, drms2).length > 0;
  }

  /**
   * Returns an array of drm infos that are present in both input arrays.
   * If one of the arrays is empty, returns the other one since clear
   * content is considered compatible with every drm info.
   *
   * @param {!Array.<!DrmInfo>} drms1
   * @param {!Array.<!DrmInfo>} drms2
   * @return {!Array.<!DrmInfo>}
   */
  static getCommonDrmInfos(drms1, drms2) {
    if (!drms1.length) {
      return drms2;
    }
    if (!drms2.length) {
      return drms1;
    }

    const commonDrms = [];

    for (const drm1 of drms1) {
      for (const drm2 of drms2) {
        // This method is only called to compare drmInfos of a video and an
        // audio adaptations, so we shouldn't have to worry about checking
        // robustness.
        if (drm1.keySystem == drm2.keySystem) {
          /** @type {Array<InitDataOverride>} */
          let initData = [];
          initData = initData.concat(drm1.initData || []);
          initData = initData.concat(drm2.initData || []);
          initData = initData.filter((d, i) => {
            return d.keyId === undefined || i === initData.findIndex((d2) => {
              return d2.keyId === d.keyId;
            });
          });

          const keyIds = drm1.keyIds && drm2.keyIds ?
            new Set([...drm1.keyIds, ...drm2.keyIds]) :
            drm1.keyIds || drm2.keyIds;
          const mergedDrm = {
            keySystem: drm1.keySystem,
            licenseServerUri: drm1.licenseServerUri || drm2.licenseServerUri,
            distinctiveIdentifierRequired: drm1.distinctiveIdentifierRequired ||
              drm2.distinctiveIdentifierRequired,
            persistentStateRequired: drm1.persistentStateRequired ||
              drm2.persistentStateRequired,
            videoRobustness: drm1.videoRobustness || drm2.videoRobustness,
            audioRobustness: drm1.audioRobustness || drm2.audioRobustness,
            serverCertificate: drm1.serverCertificate || drm2.serverCertificate,
            serverCertificateUri: drm1.serverCertificateUri ||
              drm2.serverCertificateUri,
            initData,
            keyIds,
          };
          commonDrms.push(mergedDrm);
          break;
        }
      }
    }

    return commonDrms;
  }
}

export default drm_engine;