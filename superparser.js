import dash_parser from './src/dash/dash_parser.js';
import segment_saver from './src/stream/segment_saver.js';
import widevine_drm_parser from './src/dash/widevine_drm_parser.js';
import appRoot from 'app-root-path';
import fs from 'fs';
import logger from './src/util/sp_logger.js';
import { exit } from 'process';
import commandLineArgs from 'command-line-args';
import path from 'path';
import fse from 'fs-extra';
import makeDir from 'make-dir';

const filePath = import.meta.url;

const optionDefs = [
  { name: 'id', alias: 'i', type: String },
  { name: 'serv', alias: 's', type: String },
  { name: 'netitf', alias: 'n', type: String },
  { name: 'lang', alias: 'l', type: String, multiple: true },
  { name: 'bandwidth', alias: 'b', type: String },
  { name: 'apiformat_mpd', alias: 'p', type: String },
  { name: 'apiformat_key', alias: 'k', type: String },
  { name: 'max_segment_num', alias: 'm', type: Number },
  { name: "outpath", alias: "o", type: String },
  { name: "help", alias: "h", type: Boolean, defaultValue: false }
];

/* main configuration parameter from console input */
const confArgs = commandLineArgs(optionDefs);
/* main configuration parameter from json configuration file */
const confJson = JSON.parse(fs.readFileSync('./conf.json', 'utf-8'));

if (confArgs.help) {
  console.log(`Usage: node superparser.js [options]
  
  Options:
  --id -i                          channel id
  --serv -s                        service type
  --lang -l                        language
  --bandwidth -b                   bandwidth
  --apiformat_mpd -p               format of API to get link of mpd
  --apiformat_key -k               format of API to get decryption key
  --max_segment_num -m             maximum number of segments in one track
  --outpath -o                     output path where HLS manifest is created
  --help -h                        help
  `);
  exit(0);
}

// Set output path where output manifeset and segments will be saved.
var playlistPath;
let inputPath = confArgs.outpath;
if (inputPath) {
  if (inputPath.charAt(inputPath.length - 1) != '/') {
    console.error("Output path should be folder path.");
    exit(1);
  } else {
    playlistPath = path.isAbsolute(inputPath) ? inputPath :
      appRoot.path + "/" + inputPath;
  }
} else {
  playlistPath = "/var/www/html/";
}

/* Use input parameters first, then use json conf's if input is empty. */
var conf = {};

conf.id = confArgs.id ? confArgs.id : confJson.id;
conf.service = confArgs.serv ? confArgs.serv : confJson.service;
conf.net_itf = confArgs.netitf ? confArgs.netitf : confJson.net_itf;
conf.lang = confArgs.lang ? confArgs.lang.join(', ') : confJson.lang;
conf.bandwidth = confArgs.bandwidth ? confArgs.bandwidth : confJson.bandwidth;
conf.apiformat_mpd = confArgs.apiformat_mpd ? confArgs.apiformat_mpd : confJson.apiformat_mpd;
conf.apiformat_key = confArgs.apiformat_key ? confArgs.apiformat_key : confJson.apiformat_key;
conf.max_segment_num = confArgs.max_segment_num ? confArgs.max_segment_num : confJson.max_segment_num;

playlistPath = playlistPath + conf.id + "/";

var manifest = null;
let downloadPath = appRoot.path + "/download/";
let mergePath = appRoot.path + "/output/";
let decryptScript = appRoot.path + "/bin/decrypt.sh";
let masterPlaylistPath = playlistPath + "master.m3u8";
let audioPLName = 'audioVariant.m3u8';
let videoPLName = 'videoVariant.m3u8';

var dashParser = new dash_parser(conf.apiformat_mpd, conf.service, conf.id);
var key = null;
var keyId = null;

await dashParser.start();

// Delete all previous segments.
const audioSegmentsPath = playlistPath + "audio/";
const videoSegmentsPath = playlistPath + "video/";
if (!fs.existsSync(audioSegmentsPath)) {
  makeDir(audioSegmentsPath).then(() => { });
} else {
  fse.emptyDirSync(playlistPath + "audio");
}
if (!fs.existsSync(videoSegmentsPath)) {
  makeDir(videoSegmentsPath).then(() => { });
} else {
  fse.emptyDirSync(playlistPath + "video");
}

if (!fs.existsSync(playlistPath)) {
  makeDir(playlistPath).then(() => { });
}

var audioMediaPLTemplate = [];
var videoMediaPLTemplate = [];
var lastSegmentURI = { audio: null, video: null };

while (true) {
  manifest = dashParser.manifest_;
  // Choose the most proper variant according to user input.
  var varaiantList = manifest.variants;
  var bandwidthFilteredList = [];
  varaiantList.sort((a, b) => a.bandwidth - b.bandwidth);

  let lowest, highest;
  if (conf.bandwidth == "low") {
    lowest = 0;
    highest = parseInt(varaiantList.length / 3);
  } else if (conf.bandwidth == "mid") {
    lowest = parseInt(varaiantList.length / 3) + 1;
    highest = parseInt(varaiantList.length / 3) * 2;
  } else if (conf.bandwidth == "high") {
    lowest = parseInt(varaiantList.length / 3) * 2 + 1;
    highest = varaiantList.length - 1;
  } else {
    logger.sp_error(filePath, "Bandwidth option invalid!");
    exit(1);
  }
  bandwidthFilteredList = varaiantList.slice(lowest, highest + 1);

  // Filter by lanuage options, this will start from the
  // variant with the highest bandwidth property.
  let langOpts = conf.lang.split(', ');
  var targetVariant = null;

  for (let i = bandwidthFilteredList.length - 1; i >= 0; i--) {
    for (const lang of langOpts) {
      if (bandwidthFilteredList[i].audio.language == lang) {
        targetVariant = bandwidthFilteredList[i];
        break;
      }
    }
    if (targetVariant != null)
      break;
  }

  if (targetVariant == null) {
    logger.sp_error(filePath, "No language matching variants...");
    exit(1);
  }

  const audioStream = targetVariant.audio;
  const videoStream = targetVariant.video;

  if (audioMediaPLTemplate.length == 0 && videoMediaPLTemplate.length == 0) {
    // Create master playlist.
    let template = ['#EXTM3U'];
    template.push(`#EXT-X-VERSION:7`);
    // Audio media playlist
    template.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${audioStream.language || 'en'}",NAME="${audioStream.language || 'en'}",AUTOSELECT=YES,URI="audio/${audioPLName}"`);
    // Video media playlist
    let vBandwdith = videoStream.bandwidth;
    let resolution = videoStream.width + 'x' + videoStream.height;
    let frameRate = (Math.round(eval(videoStream.frameRate) * 100) / 100).toString();
    let codec = videoStream.codecs;
    template.push(`#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${vBandwdith},RESOLUTION=${resolution},CODECS="${codec}",FRAME-RATE=${frameRate},AUDIO="audio"
video/${videoPLName}`);
    fs.writeFileSync(masterPlaylistPath, template.join('\n'));

    // Initialize media playlist
    audioMediaPLTemplate.push(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-TARGETDURATION:${parseInt(dashParser.updatePeriod_)}
#EXT-X-MEDIA-SEQUENCE:0
`);

    videoMediaPLTemplate.push(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-TARGETDURATION:${parseInt(dashParser.updatePeriod_)}
#EXT-X-MEDIA-SEQUENCE:0
`);
  }

  // Get decryption key only when manifest is expired
  if (dashParser.manifestExpired) {
    // Get decryption key, will be updated after manifest is expired and updated.
    var drmParser = new widevine_drm_parser(targetVariant.drmInfos);
    key = await drmParser.get_decryption_key(conf.apiformat_key, conf.service, conf.id);
    keyId = drmParser.get_keyId();
    dashParser.manifestExpired = false;
  }

  await audioStream.createSegmentIndex();
  await videoStream.createSegmentIndex();

  const audioSegmentIndex = audioStream.segmentIndex.indexes_[0];
  const videoSegmentIndex = videoStream.segmentIndex.indexes_[0];

  const endPlayTime = manifest.presentationTimeline.getSegmentAvailabilityEnd();

  var segmentMgr = new segment_saver(audioSegmentIndex, videoSegmentIndex,
    key, keyId, decryptScript, playlistPath, endPlayTime, lastSegmentURI, conf.max_segment_num);

  lastSegmentURI = await segmentMgr.download_segments(downloadPath, mergePath,
    audioMediaPLTemplate, videoMediaPLTemplate, audioPLName, videoPLName);

  /**
   * Check if current time is before the expire time which we
   * got from manifest API.
   */
  let currentTimeInSecond = Math.round((Date.now()) / 1000);
  if (currentTimeInSecond >= dashParser.expireTime_) {
    logger.sp_warn(filePath, 'Manifest is expired, re-fetching manifest URI...');
    await dashParser.getManifestURI_(this.apiURLFormat_, this.serviceId_, this.id_);
    dashParser.manifestExpired = true;
  }

  // After all segments are downloaded, then update the manifest
  logger.sp_log(filePath, 'Updating Manifest...');
    await dashParser.requestManifest_();
}
