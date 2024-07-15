import { segment_index } from '../media/segment_index.js';
import fs from 'fs';
import fse from 'fs-extra';
import logger from '../util/sp_logger.js';
import network_engine from '../net/network_engine.js';
import { proxyConf } from '../../proxy_conf.js';
import shell from 'shelljs';
import mergeFiles from 'merge-files';
import appRoot from 'app-root-path';
import path from 'path';
import error from '../util/error.js';
import assert from 'assert';

var filePath = import.meta.url;

/**
 * Download all segments from segment index and decrypt them
 * by using their init data and our own API
 */
class segment_saver {
  /**
   * @param {segment_index} audioSegmentIndex target segment index from which
   * all audio segment files are downloaded.
   * @param {segment_index} videoSegmentIndex target segment index from which
   * all video segment files are downloaded.
   * @param {string} key decryption key derived from pssh in manifest and our API.
   * @param {string} keyId key Id
   * @param {string} decryptScript external script for decrypting segments.
   * @param {string} resultPath path to save completed segments.
   * @param {number} endPlayTime average start time of live edge segment
   * @param {object} lastSegmentURI URI of segment processed most latestly
   * 
   */
  constructor(audioSegmentIndex, videoSegmentIndex, key, keyId, decryptScript,
    resultPath, endPlayTime, lastSegmentURI, maxSegmentNum) {
    this.audioSegmentUrlList_ = [];
    this.audioSegmentDurationList_ = [];
    this.videoSegmentUrlList_ = [];
    this.videoSegmentDurationList_ = [];
    this.maxSegmentNum_ = maxSegmentNum;

    // initialize audio segment URI list
    this.audioSegmentUrlList_.push(audioSegmentIndex.references[0].initSegmentReference.getUris()[0]);
    this.audioSegmentDurationList_.push(0);
    let foundLastestURI = false;
    let foundStartSegment = false;
    audioSegmentIndex.forEachTopLevelReference((ref) => {
      let segURI = ref.getUrisInner()[0];
      if (foundStartSegment || foundLastestURI) {
        this.audioSegmentUrlList_.push(segURI);
        this.audioSegmentDurationList_.push(ref.endTime - ref.startTime);
      }

      if (lastSegmentURI.audio) {
        if (segURI == lastSegmentURI.audio) {
          foundLastestURI = true;
        }
      } else {
        let refIndex = audioSegmentIndex.references.indexOf(ref);
        if (refIndex < audioSegmentIndex.references.length - maxSegmentNum &&
            audioSegmentIndex.references[refIndex + maxSegmentNum].endTime > endPlayTime) {
          foundStartSegment = true;
        }
      }
    });

    // initialize video segment URI list
    foundLastestURI = false;
    foundStartSegment = false;
    this.videoSegmentUrlList_.push(videoSegmentIndex.references[0].initSegmentReference.getUris()[0]);
    this.videoSegmentDurationList_.push(0);
    videoSegmentIndex.forEachTopLevelReference((ref) => {
      let segURI = ref.getUrisInner()[0];
      if (foundStartSegment || foundLastestURI) {
        this.videoSegmentUrlList_.push(segURI);
        this.videoSegmentDurationList_.push(ref.endTime - ref.startTime);
      }

      if (lastSegmentURI.video) {
        if (segURI == lastSegmentURI.video) {
          foundLastestURI = true;
        }
      } else {
        let refIndex = videoSegmentIndex.references.indexOf(ref);
        if (refIndex < videoSegmentIndex.references.length - maxSegmentNum &&
          videoSegmentIndex.references[refIndex + maxSegmentNum].endTime > endPlayTime) {
          foundStartSegment = true;
        }
      }
    });

    this.decryptKey_ = key;
    this.keyId_ = keyId;
    this.decryptScript_ = decryptScript;
    if (!fs.existsSync(resultPath)) {
      logger.sp_warn(filePath, "Default result path %s doesn't exist, creating new one...",
        resultPath);
      fs.mkdirSync(resultPath);
    }

    this.resultPath_ = resultPath;
  }

  clearReference_() {
    this.audioSegmentUrlList_ = [];
    this.audioSegmentDurationList_ = [];
    this.videoSegmentUrlList_ = [];
    this.videoSegmentDurationList_ = [];
    this.decryptKey_ = undefined;
    this.keyId_ = undefined;
    this.decryptScript_ = undefined;
    this.resultPath_ = undefined;
  }

  async download_segments(savePath, mergePath, audioMediaPLTemplate, videoMediaPLTemplate,
    audioPLName, videoPLName) {
    let i = 0;
    if (!fs.existsSync(savePath)) {
      logger.sp_warn(filePath, "Default download path %s doesn't exist, creating new one...",
        savePath);
      fs.mkdirSync(savePath);
    }
    if (!fs.existsSync(mergePath)) {
      logger.sp_warn(filePath, "Path %s where combined segments will be saved doesn't exist, creating new one...",
        mergePath);
      fs.mkdirSync(mergePath);
    }

    // assert(this.audioSegmentUrlList_.length == this.videoSegmentUrlList_.length);

    // total segments number = url list length - 1 (init segment isn't involved)
    logger.sp_log(filePath, `Process ${this.audioSegmentDurationList_.length - 1} segment(s) for 2 tracks...`);

    let lastAudioURI = null;
    let lastVideoURI = null;

    for (let i = 0; i < this.audioSegmentUrlList_.length; i++) {
      var segmentUrl;
      var segmentDuration;
      var pathSuffix;
      var initFile = "init.mp4";
      var mediaPlaylistTemplate;
      var playlistName;
      var mediaPlaylistPath;
      var bufferFull = false;

      // check how long it take to process one segment per track
      let checkStart = Date.now();
      let processPeriod;

      // traverse both audio and video segments
      for (let j = 0; j < 2; j++) {
        if (j == 0) {
          segmentUrl = this.audioSegmentUrlList_[i];
          segmentDuration = this.audioSegmentDurationList_[i];
          pathSuffix = "audio/";
          mediaPlaylistTemplate = audioMediaPLTemplate;
          playlistName = audioPLName;
          lastAudioURI = segmentUrl;
        } else {
          segmentUrl = this.videoSegmentUrlList_[i];
          segmentDuration = this.videoSegmentDurationList_[i];
          pathSuffix = "video/";
          mediaPlaylistTemplate = videoMediaPLTemplate;
          playlistName = videoPLName;
          lastVideoURI = segmentUrl;
        }
        mediaPlaylistPath = this.resultPath_ + pathSuffix + playlistName;

        var segmentName = segmentUrl.split('/').pop();
        // Use fixed length decimal number format instead, so that segments can be sorted
        // easily in any file explorer.
        var extension = path.extname(segmentName);
        var nameOnly = path.basename(segmentName, extension);
        let numberedName = parseInt('0x' + nameOnly);
        let converted = isNaN(numberedName) ? nameOnly : String(numberedName).padStart(12, '0');
        segmentName = converted + extension;

        let saveName = savePath + pathSuffix + segmentName;

        await network_engine.socks5_http_download(segmentUrl, saveName, proxyConf);

        // Combine each segments with init one.
        if (segmentName != initFile) {
          const inputPathList = [];
          inputPathList.push(savePath + pathSuffix + initFile);
          inputPathList.push(saveName);
          let mergeFileName = mergePath + pathSuffix + segmentName;
          const status = await mergeFiles(inputPathList, mergeFileName);
          if (status) {
            // Decrypt the segment.
            const nameOnly = path.basename(segmentName, path.extname(segmentName));
            const resultFileRelativePath = pathSuffix + nameOnly + ".mp4";
            let decryptCommand = this.decryptScript_ + " " + this.keyId_ + " " +
              this.decryptKey_ + " " + mergeFileName + " " + this.resultPath_ +
              resultFileRelativePath + " " + appRoot.path + " " + pathSuffix.slice(0, -1);
            if (shell.exec(decryptCommand).code !== 0) {
              logger.sp_error(filePath, "Decrypting failed.");
              throw new error(
                error.Severity.CRITICAL,
                error.Category.SEGMENT,
                error.Code.SEGMENT_MANIPULATION_FAILED);
            }
            logger.sp_log(filePath, `${pathSuffix.slice(0, -1)} ${nameOnly} Decrypted.`);

            // As soon as the new segments are decrypted and added, then
            // update the media playlist also.

            let newSegmentUri = nameOnly + ".mp4";
            let segmentTemplate = `#EXTINF:${segmentDuration},
${newSegmentUri}`;

            // Get the total number of segments and check if
            // it exceeds the max segment number. If yes, 
            // then delete old ones.
            let segmentItemList = [];
            mediaPlaylistTemplate.map((item) => {
              if (item.includes('#EXTINF:')) {
                segmentItemList.push(item);
              }
            });
            if (segmentItemList.length == this.maxSegmentNum_) {
              bufferFull = true;
              const oldItem = segmentItemList.shift();
              mediaPlaylistTemplate.splice(mediaPlaylistTemplate.indexOf(oldItem), 1);

              // Delete respective file really also, not just manifest item
              let oldFilename = this.resultPath_ + pathSuffix + oldItem.split('\n').pop();
              fs.unlinkSync(oldFilename);

              // get the name of first item now to update media sequence
              segmentItemList.push(segmentTemplate);

              let regEx = RegExp(/#EXT-X-MEDIA-SEQUENCE:\d+/i);
              let oldSequenceNumber = parseInt((regEx.exec(mediaPlaylistTemplate[0])[0]).replace(/^\D+/g, ''));
              let newSequenceNumber = oldSequenceNumber + 1;
              const mediaSequenceStr = `#EXT-X-MEDIA-SEQUENCE:${newSequenceNumber}`;
              let newItem = mediaPlaylistTemplate[0].replace(/#EXT-X-MEDIA-SEQUENCE:\d+/i, mediaSequenceStr);
              mediaPlaylistTemplate[0] = newItem;
            }

            mediaPlaylistTemplate.push(segmentTemplate);
            fs.writeFileSync(mediaPlaylistPath, mediaPlaylistTemplate.join('\n'));


          } else {
            logger.sp_error(filePath, "Failed to combine segments");
            throw new error(
              error.Severity.CRITICAL,
              error.Category.SEGMENT,
              error.Code.SEGMENT_MANIPULATION_FAILED);
          }
        }
      }

      // if processing period is less than segment update period defined in manifest,
      // sleep for timeoffest(segment update period - processing period)
      processPeriod = Date.now() - checkStart;
      logger.sp_log(filePath, `${processPeriod / 1000} second(s) elapsed`);
      let segmentDurationMiliSec = segmentDuration * 1000;
      if (processPeriod < segmentDurationMiliSec && bufferFull) {
        let sleepingDuration = segmentDurationMiliSec - processPeriod;
        logger.sp_log(filePath, `Sleeping for ${sleepingDuration / 1000}s...`);
        await this.sleep_(sleepingDuration);
      }
    }

    // Delete downloaded segments and combined ones.
    fse.emptyDirSync(savePath + "audio");
    fse.emptyDirSync(savePath + "video");
    fse.emptyDirSync(mergePath + "audio");
    fse.emptyDirSync(mergePath + "video");

    this.clearReference_();

    return {
      audio: lastAudioURI,
      video: lastVideoURI
    };
  }

  sleep_(millis) {
    return new Promise(resolve => setTimeout(resolve, millis));
  }
}

export default segment_saver;