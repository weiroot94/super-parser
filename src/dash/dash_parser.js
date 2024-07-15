import assert from 'assert';
import period_combiner from '../util/period_combiner.js';
import timer from '../util/timer.js';
import logger from '../util/sp_logger.js';
import operation_manager from '../util/operation_manager.js';
import network_engine from '../net/network_engine.js';
import error from '../util/error.js';
import mpd_utils from './mpd_utils.js';
import xml_utils from '../util/xml_utils.js';
import functional from '../util/functional.js';
import manifest_parser_utils from '../util/manifest_parser_utils.js';
import mime_utils from '../util/mime_utils.js';
import language_utils from '../util/language_utils.js';
import content_protection from './content_protection.js';
import { proxyConf } from '../../proxy_conf.js';
import { keySystemByURI } from '../constants/sp_conf.js';
import segment_base from './segment_base.js';
import segment_list from './segment_list.js';
import segment_template from './segment_template.js';
import { segment_index } from '../media/segment_index.js';
import presentation_timeline from '../media/presentation_timeline.js';
import text_engine from '../text/text_engine.js';
import ewma from '../abr/ewma.js';
import manifest_parser from '../media/manifest_parser.js';
import spEventsMgr from '../util/sp_events_manager.js';

const filePath = import.meta.url;

class dash_parser {
  constructor(APIformat, serviceId, id) {
    /**
     * These 3 memebers are used to fetch manifest URL, it is re-
     * fetched whenever the current manifest is expired.
     */
    this.apiURLFormat_ = APIformat;
    this.serviceId_ = serviceId;
    this.id_ = id;

    this.manifestUri_ = null;
    this.manifest_ = null;
    this.globalId_ = 1;
    this.expireTime_ = null;

    /**
     * A map of IDs to stream objects
     * ID: Period@id, adaptationSet@id,@Representaion@id
     * e.g.:'1,5,23'
     */
    this.streamMap_ = {};

    /**
     * A map of period ids to their durations
     */
    this.periodDurations_ = {};

    this.periodCombiner_ = new period_combiner();

    /**
     * The update period in seconds, or 0 for no updates
     */
    this.updatePeriod_ = 0;

    /**
     * An ewma that tracks how long updates take.
     * This is to mitigate issues caused by slow parsing on embedded devices.
     * @private {!ewma}
     */
    this.averageUpdateDuration_ = new ewma(5);

    this.updateTimer_ = new timer(() => {
      this.onUpdate_();
    });

    this.operationManager_ = new operation_manager();

    /**
     * Largest period start time seen
     */
    this.largestPeriodStartTime_ = null;

    /**
     * Period IDs seen in previous manifest
     */
    this.lastManifestUpdatePeriodIds_ = [];

    /**
     * The minimum of the availabilityTimeOffset values among the adaption sets.
     */
    this.minTotalAvailabilityTimeOffest_ = Infinity;

    /**
     * True if the manifest isn't expired yet, false once it does.
     * It is true by default to get decryption key from the first time.
     */
    this.manifestExpired = true;
  }

  async start() {
    // First, we need to get URI of manifest to be parsed.
    await this.getManifestURI_(this.apiURLFormat_, this.serviceId_, this.id_);

    const updateDelay = await this.requestManifest_();
    // this.setUpdateTimer_(updateDelay);

    /* Manifest should be non-null! */
    assert(this.manifest_);
    return this.manifest_;
  }

  stop() {
    /* When the parser stops, release all segment indexes, which stops their timers, as well */
    for (const stream of Object.values(this.streamMap_)) {
      if (stream.segmentIndex) {
        stream.segmentIndex.release();
      }
    }

    if (this.periodCombiner_) {
      this.periodCombiner_.release();
    }

    this.manifestUri_ = null;
    this.manifest_ = null;
    this.streamMap_ = {};
    this.periodCombiner_ = null;

    if (this.updateTimer_ != null) {
      this.updateTimer_.stop();
      this.updateTimer_ = null;
    }

    return this.operationManager_.destroy();
  }

  /**
   * We use our specialized API for getting URL of manifest.
   * 
   * @param apiURLFormat formatted string for manifest API
   * @param service service type; will be used in apiURLformat
   * @param id id; will be used in apiURLformat
   * @return manifest URI
   * @private
   */
  async getManifestURI_(apiFormat, service, id) {
    let api_mpd = apiFormat.replace(/{service}/g, service).replace(/{id}/g, id);

    const mpdAPIResponse = await network_engine.http_get(api_mpd);
    this.manifestUri_ = mpdAPIResponse.data;
    this.expireTime_ = mpdAPIResponse.expiry;
    logger.sp_log(filePath, `Manifest will be expired at ${new Date(this.expireTime_ * 1000)}.`);
  }

  /**
   * Make a network request for the manifest and parses the resulting data
   * 
   * @return {!Promise.<number>} Resolves with the time it took, in seconds, to
   *  fullfill the request and parse the data
   */
  async requestManifest_() {
    const startTime = Date.now();

    /* Get the manifest content from URL using network engine */
    logger.sp_debug(filePath, "Fetching manifest...");
    let mpdData = await network_engine.socks5_http_get(this.manifestUri_, proxyConf);

    await this.parseManifest_(mpdData);
    const endTime = Date.now();
    const updateDuration = (endTime - startTime) / 1000.0;
    this.averageUpdateDuration_.sample(1, updateDuration);

    /* Let the caller know how long this update took. */
    return updateDuration;
  }

  /**
   * Parses the manifest XML.  This also handles updates and will update the
   * stored manifest.
   *
   * @param {BufferSource} data
   * @return {!Promise}
   * @private
   */
  async parseManifest_(data) {
    const mpd = xml_utils.parseXml(data, 'MPD');
    if (!mpd) {
      throw new error(
        error.Severity.CRITICAL, error.Category.MANIFEST,
        error.Code.DASH_INVALID_XML);
    }

    return await this.processManifest_(mpd);
  }

  /**
   * Takes a formatted MPD and converts it into a manifest.
   * 
   * @param {!Element} mpd
   * @return {!Promise}
   * @private
   */
  async processManifest_(mpd) {
    const locations = xml_utils.findChildren(mpd, 'Location')
      .map(xml_utils.getContents)
      .filter(functional.isNotNull);

    if (locations.length > 0) {
      logger.sp_debug(filePath, "Location information exists, need to be resolved");
    }
    logger.sp_debug(filePath, "Parsing manifest started");

    const uriObjs = xml_utils.findChildren(mpd, 'BaseURL');
    const baseUris = uriObjs.map(xml_utils.getContents);

    let availabilityTimeOffset = 0;
    if (uriObjs && uriObjs.length) {
      availabilityTimeOffset = xml_utils.parseAttr(
        uriObjs[0], 'availabilityTimeOffset', xml_utils.parseFloat) || 0;
    }
    let minBufferTime =
      xml_utils.parseAttr(mpd, 'minBufferTime', xml_utils.parseDuration) || 0;

    this.updatePeriod_ = xml_utils.parseAttr(mpd, 'minimumUpdatePeriod',
      xml_utils.parseDuration, -1);

    const presentationStartTime = xml_utils.parseAttr(mpd, 'availabilityStartTime',
      xml_utils.parseDate);
    let segmentAvailabilityDuration = xml_utils.parseAttr(mpd, 'timeShiftBufferDepth',
      xml_utils.parseDuration);

    let suggestedPresentationDelay = xml_utils.parseAttr(
      mpd, 'suggestedPresentationDelay', xml_utils.parseDuration);

    let maxSegmentDuration = xml_utils.parseAttr(
      mpd, 'maxSegmentDuration', xml_utils.parseDuration);

    const mpdType = mpd.getAttribute('type') || 'static';

    let presentationTimeline;
    if (this.manifest_) {
      presentationTimeline = this.manifest_.presentationTimeline;

      // Before processing an update, evict from all segment indexes.  Some of
      // them may not get updated otherwise if their corresponding Period
      // element has been dropped from the manifest since the last update.
      // Without this, playback will still work, but this is necessary to
      // maintain conditions that we assert on for multi-Period content.
      // This gives us confidence that our state is maintained correctly, and
      // that the complex logic of multi-Period eviction and period-flattening
      // is correct.  See also:
      // https://github.com/shaka-project/shaka-player/issues/3169#issuecomment-823580634
      for (const stream of Object.values(this.streamMap_)) {
        if (stream.segmentIndex) {
          stream.segmentIndex.evict(
            presentationTimeline.getSegmentAvailabilityStart());
        }
      }
    } else {
      // DASH IOP v3.0 suggests using a default delay between minBufferTime
      // and timeShiftBufferDepth.  This is literally the range of all
      // feasible choices for the value.  Nothing older than
      // timeShiftBufferDepth is still available, and anything less than
      // minBufferTime will cause buffering issues.
      //
      // We have decided that our default will be the configured value, or
      // 1.5 * minBufferTime if not configured. This is fairly conservative.
      // Content providers should provide a suggestedPresentationDelay whenever
      // possible to optimize the live streaming experience.
      const defaultPresentationDelay = minBufferTime * 1.5;
      const presentationDelay = suggestedPresentationDelay != null ?
        suggestedPresentationDelay : defaultPresentationDelay;
      presentationTimeline = new presentation_timeline(
        presentationStartTime, presentationDelay, true);
    }

    presentationTimeline.setStatic(mpdType == 'static');

    const isLive = presentationTimeline.isLive();

    // If it's live, we check for an override.
    if (isLive && !isNaN(NaN)) {
      segmentAvailabilityDuration = NaN;
    }

    // If it's null, that means segments are always available.  This is always
    // the case for VOD, and sometimes the case for live.
    if (segmentAvailabilityDuration == null) {
      segmentAvailabilityDuration = Infinity;
    }

    presentationTimeline.setSegmentAvailabilityDuration(
      segmentAvailabilityDuration);

    const profiles = mpd.getAttribute('profiles') || '';

    logger.sp_debug(filePath, "Top level element; minimumUpdatePeriod: %s, " +
      "availabilityStartTime: %s timeShiftBufferDepth: %s, mpdType: %s, " +
      "profiles: %j, availabilityTimeOffset: %f, minBufferTime: %d, " +
      "suggestedPresentationDelay: %d, maxSegmentDuration: %d", this.updatePeriod_,
      presentationStartTime, segmentAvailabilityDuration, mpdType, profiles,
      availabilityTimeOffset, minBufferTime, suggestedPresentationDelay, maxSegmentDuration);

    const context = {
      dynamic: mpdType != 'static',
      presentationTimeline: presentationTimeline,
      period: null,
      periodInfo: null,
      adaptationSet: null,
      representation: null,
      bandwidth: 0,
      indexRangeWarningGiven: false,
      availabilityTimeOffset: availabilityTimeOffset,
      profiles: profiles.split(','),
    };

    /* parse periods */
    const periodsAndDuration = this.parsePeriods_(context, baseUris, mpd);
    const duration = periodsAndDuration.duration;
    const periods = periodsAndDuration.periods;

    if (mpdType == 'static' ||
      !periodsAndDuration.durationDerivedFromPeriods) {
      // Ignore duration calculated from Period lengths if this is dynamic.
      presentationTimeline.setDuration(duration || Infinity);
    }

    // Use @maxSegmentDuration to override smaller, derived values.
    presentationTimeline.notifyMaxSegmentDuration(maxSegmentDuration || 1);

    await this.periodCombiner_.combinePeriods(periods, context.dynamic);

    // These steps are not done on manifest update.
    if (!this.manifest_) {
      this.manifest_ = {
        presentationTimeline: presentationTimeline,
        variants: this.periodCombiner_.getVariants(),
        textStreams: this.periodCombiner_.getTextStreams(),
        imageStreams: this.periodCombiner_.getImageStreams(),
        offlineSessionIds: [],
        minBufferTime: minBufferTime || 0,
        sequenceMode: false,
      };

      logger.sp_debug(filePath, "Periods are re-parsed and combined to different stream and varants.");

      // We only need to do clock sync when we're using presentation start
      // time. This condition also excludes VOD streams.
      if (presentationTimeline.usingPresentationStartTime()) {
        const timingElements = xml_utils.findChildren(mpd, 'UTCTiming');
        const offset = await this.parseUtcTiming_(baseUris, timingElements);

        presentationTimeline.setClockOffset(offset);
      }
    } else {
      // Just update the variants and text streams, which may change as periods
      // are added or removed.
      this.manifest_.variants = this.periodCombiner_.getVariants();
      this.manifest_.textStreams = this.periodCombiner_.getTextStreams();
      this.manifest_.imageStreams = this.periodCombiner_.getImageStreams();
    }

    var targetVariant = this.manifest_.variants[0];
  }

  /**
   * Reads and parses the periods from the manifest. The first does some
   * partial parsing so that start and duration is available when parsing
   * children.
   * 
   * @param context
   * @param baseUris
   * @param {!Node element} mpd
   * @return {{
   *  periods: !Array.<period_combiner.Period>,
   *  duration: ?number,
   *  durationDerivedFromPeriods: boolean
   * }}
   * @private
   */
  parsePeriods_(context, baseUris, mpd) {
    logger.sp_debug(filePath, "Starting Parsing Period Elements...");
    const presentationDuration = xml_utils.parseAttr(
      mpd, 'mediaPresentationDuration', xml_utils.parseDuration);

    const periods = [];
    let prevEnd = 0;
    const periodNodes = xml_utils.findChildren(mpd, 'Period');

    logger.sp_log(filePath, "%d Period(s) found.", periodNodes.length);

    for (let i = 0; i < periodNodes.length; i++) {
      const elem = periodNodes[i];
      const next = periodNodes[i + 1];
      const start = xml_utils.parseAttr(elem, 'start', xml_utils.parseDuration, prevEnd);
      const periodId = elem.getAttribute('id');
      const givenDuration = xml_utils.parseAttr(elem, 'duration', xml_utils.parseDuration);

      logger.sp_debug(filePath, "Period %s: start: %s duration: %s", periodId, start, givenDuration);

      let periodDuration = null;
      if (next) {
        // The difference between the start time of a Period and the start time
        // of the following Period is the duration of the media content
        // represented by this Period.
        const nextStart = xml_utils.parseAttr(next, 'start', xml_utils.parseDuration);
        if (nextStart != null) {
          periodDuration = nextStart - start;
        }
      } else if (presentationDuration != null) {
        // The Period extends until the Period.start of the next Period, or
        // until the end of the Media Presentation in the case of the last
        // Period.
        periodDuration = presentationDuration - start;
      }

      const thresold = manifest_parser_utils.GAP_OVERLAP_TOLERANCE_SECONDS;
      if (periodDuration && givenDuration &&
        Math.abs(periodDuration - givenDuration) > thresold) {
        logger.sp_warn(filePath, "There is a gap/overlap between Periods");
      }

      // Only use the @duration in the MPD if we can't calculate it. We should
      // favor the @start of the follwing Period. This ensures that there
      // aren't gaps between Periods
      if (periodDuration == null) {
        periodDuration = givenDuration;
      }

      // Parse child nodes.
      const info = {
        start: start,
        duration: periodDuration,
        node: elem,
        isLastPeriod: periodDuration == null || !next,
      };

      const period = this.parsePeriod_(context, baseUris, info);
      periods.push(period);

      if (context.period.id && periodDuration) {
        this.periodDurations_[context.period.id] = periodDuration;
      }

      if (periodDuration == null) {
        if (next) {
          // If the duration is still null and we aren't at the end, then we
          // will skip any remaining periods.
          logger.sp_warn(filePath,
            'Skipping Period', i + 1, 'and any subsequent Periods:', 'Period',
            i + 1, 'does not have a valid start time.', next);
        }

        // The duration is unknown, so the end is unknown.
        prevEnd = null;
        break;
      }

      prevEnd = start + periodDuration;
    } // end of period parsing loop

    logger.sp_debug(filePath, "All Periods are parsed now.");

    // Replace previous seen periods with the current one.
    this.lastManifestUpdatePeriodIds_ = periods.map((el) => el.id);

    if (presentationDuration != null) {
      if (prevEnd != presentationDuration) {
        logger.sp_warn(filePath,
          '@mediaPresentationDuration does not match the total duration of ',
          'all Periods.');
        // Assume @mediaPresentationDuration is correct.
      }
      return {
        periods: periods,
        duration: presentationDuration,
        durationDerivedFromPeriods: false,
      };
    } else {
      return {
        periods: periods,
        duration: prevEnd,
        durationDerivedFromPeriods: true,
      };
    }
  }

  /**
   * Parses a Period XML element. Unlike the other parse methods, this is not
   * given the Node; it is given a PeriodInfo structure. Also, partial parsing
   * was done before this was called so start and duration are valid
   * 
   * @param context
   * @param {!Array.<string>} baseUris
   * @param {dash_parser.periodInfo} periodInfo
   * @return {util.period_combiner.Period}
   * @private
   */
  parsePeriod_(context, baseUris, periodInfo) {
    const ContentType = manifest_parser_utils.ContentType;

    context.period = this.createFrame_(periodInfo.node, null, baseUris);
    context.periodInfo = periodInfo;

    // If the period doesn't have an ID, give it one based on its start time.
    if (!context.period.id) {
      logger.sp_log(filePath,
        'No Period ID given for Period with start time ' + periodInfo.start +
        ', Assigning a default'
      );
      context.period.id = '__sp_period_' + periodInfo.start;
    }

    // ignore EventStream tags for now
    // const eventStreamNodes =
    //   xml_utils.findChildren(periodInfo.node, 'EventStream');

    const adaptationSetNodes =
      xml_utils.findChildren(periodInfo.node, 'AdaptationSet');

    logger.sp_debug(filePath, "%d AdaptationSet(s) found. Start Parsing them all...", adaptationSetNodes.length);

    const adaptationSets = adaptationSetNodes
      .map((node) => this.parseadaptationSet_(context, node))
      .filter(functional.isNotNull);

    // For dynamic manifests, we use rep IDs internally, and they must be
    // unique.
    if (context.dynamic) {
      const ids = [];
      for (const set of adaptationSets)
        for (const id of set.representationIds) {
          ids.push(id);
        }

      const uniqueIds = new Set(ids);
      logger.sp_debug(filePath, `Dynamic manifest has following unique representation Ids: ${[...uniqueIds].join(', ')}`);

      // Representation Ids must be unique each other.
      if (ids.length != uniqueIds.size) {
        throw new error(
          error.Severity.CRITICAL,
          error.Category.MANIFEST,
          error.Code.DASH_DUPLICATE_REPRESENTATION_ID);
      }
    }

    const normalAdaptationSets = adaptationSets
      .filter((as) => { return !as.trickModeFor; });

    const trickModeAdaptationSets = adaptationSets
      .filter((as) => { return as.trickModeFor; });

    // Attach trick mode tracks to normal tracks.
    for (const trickModeSet of trickModeAdaptationSets) {
      const targetIds = trickModeSet.trickModeFor.split(' ');
      for (const normalSet of normalAdaptationSets) {
        if (targetIds.includes(normalSet.id)) {
          for (const stream of normalSet.streams) {
            // There may be multiple trick mode streams, but we do not
            // currently support that.  Just choose one.
            // TODO: https://github.com/shaka-project/shaka-player/issues/1528
            stream.trickModeVideo = trickModeSet.streams.find((trickStream) =>
              mime_utils.getCodecBase(stream.codecs) ==
              mime_utils.getCodecBase(trickStream.codecs));
          }
        }
      }
    }

    const audioSets = this.getSetsOfType_(normalAdaptationSets, ContentType.AUDIO);
    const videoSets = this.getSetsOfType_(normalAdaptationSets, ContentType.VIDEO);
    const textSets = this.getSetsOfType_(normalAdaptationSets, ContentType.TEXT);
    const imageSets = this.getSetsOfType_(normalAdaptationSets, ContentType.IMAGE);

    if (!videoSets.length && !audioSets.length) {
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MANIFEST,
        error.Code.DASH_EMPTY_PERIOD);
    }

    const audioStreams = [];
    for (const audioSet of audioSets) {
      audioStreams.push(...audioSet.streams);
    }

    const videoStreams = [];
    for (const videoSet of videoSets) {
      videoStreams.push(...videoSet.streams);
    }

    const textStreams = [];
    for (const textSet of textSets) {
      textStreams.push(...textSet.streams);
    }

    const imageStreams = [];
    for (const imageSet of imageSets) {
      imageStreams.push(...imageSet.streams);
    }

    let periodId = context.period.id;
    logger.sp_debug(filePath, `Period ${periodId} parsed. Streams are sorted in forms of video, audio, text, image.`);

    return {
      id: context.period.id,
      audioStreams,
      videoStreams,
      textStreams,
      imageStreams,
    };
  }

  /**
   * @param {!Array.<!dash_parser.AdaptationInfo>} adaptationSets
   * @param {string} type
   * @return {!Array.<!dash_parser.AdaptationInfo>}
   * @private
   */
  getSetsOfType_(adaptationSets, type) {
    return adaptationSets.filter((as) => {
      return as.contentType == type;
    });
  }

  /**
   * Parses an AdaptationSet XML element.
   * 
   * @param context
   * @param elem The AdaptationSet element.
   * @return {?dash_parser.AdaptationInfo}
   * @private
   */
  parseadaptationSet_(context, elem) {
    const ContentType = manifest_parser_utils.ContentType;

    context.adaptationSet = this.createFrame_(elem, context.period, null);

    logger.sp_debug(filePath, "Checking Roles...");

    let main = false;
    const roleElements = xml_utils.findChildren(elem, 'Role');
    const roleValues = roleElements.map((role) => {
      return role.getAttribute('value');
    }).filter(functional.isNotNull);

    // Default kind for text streams is 'subtitle' if unspecified in the
    // manifest.
    let kind = undefined;
    const isText = context.adaptationSet.contentType == ContentType.TEXT;
    if (isText) {
      kind = manifest_parser_utils.TextStreamKind.SUBTITLE;
    }

    logger.sp_debug(filePath, "%d Role(s) found, starting parsing them...", roleElements.length);

    for (const roleElement of roleElements) {
      const scheme = roleElement.getAttribute('schemeIdUri');
      if (scheme == null || scheme == 'urn:mpeg:dash:role:2011') {
        // These only apply for the given scheme, but allow them to be specified
        // if there is no scheme specified.
        // See: DASH section 5.8.5.5
        const value = roleElement.getAttribute('value');
        switch (value) {
          case 'main':
            main = true;
            break;
          case 'caption':
          case 'subtitle':
            kind = value;
            break;
        }
        logger.sp_debug(filePath, `MPEG-DASH Role found; main: ${main}(main) kind: ${kind}(caption/subtitle)`);
      }
    }

    // Parallel for HLS VIDEO-RANGE as defined in DASH-IF IOP v4.3 6.2.5.1.
    let videoRange;
    const videoRangeScheme = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
    const getVideoRangeFromTransferCharacteristicCICP = (cicp) => {
      switch (cicp) {
        case 1:
        case 6:
        case 13:
        case 14:
        case 15:
          return 'SDR';
        case 16:
          return 'PQ';
        case 18:
          return 'HLG';
      }
      return undefined;
    };

    const essentialProperties =
      xml_utils.findChildren(elem, 'EssentialProperty');
    // ID of real AdaptationSet if this is a trick mode set:
    let trickModeFor = null;
    let unrecognizedEssentialProperty = false;

    logger.sp_debug(filePath, `${essentialProperties.length} EssentialProperty(s) Found`);

    for (const prop of essentialProperties) {
      const schemeId = prop.getAttribute('schemeIdUri');
      if (schemeId == 'http://dashif.org/guidelines/trickmode') {
        trickModeFor = prop.getAttribute('value');
      } else if (schemeId == videoRangeScheme) {
        videoRange = getVideoRangeFromTransferCharacteristicCICP(
          parseInt(prop.getAttribute('value'), 10),
        );
      } else {
        unrecognizedEssentialProperty = true;
      }
    }

    const supplementalProperties =
      xml_utils.findChildren(elem, 'SupplementalProperty');

    logger.sp_debug(filePath, `${supplementalProperties.length} SupplementalProperty(s) Found`);

    for (const prop of supplementalProperties) {
      const schemeId = prop.getAttribute('schemeIdUri');
      if (schemeId == videoRangeScheme) {
        videoRange = getVideoRangeFromTransferCharacteristicCICP(
          parseInt(prop.getAttribute('value'), 10),
        );
      }
    }

    // ignore caption for now

    // According to DASH spec (2014) section 5.8.4.8, "the successful processing
    // of the descriptor is essential to properly use the information in the
    // parent element".  According to DASH IOP v3.3, section 3.3.4, "if the
    // scheme or the value" for EssentialProperty is not recognized, "the DASH
    // client shall ignore the parent element."
    if (unrecognizedEssentialProperty) {
      // Stop parsing this AdaptationSet and let the caller filter out the
      // nulls.
      return null;
    }

    const contentProtectionElems =
      xml_utils.findChildren(elem, 'ContentProtection');

    logger.sp_debug(filePath, `${contentProtectionElems.length} contentProtection element(s) found, parsing them...`);

    const contentProtection = content_protection.parseFromAdaptationSet(
      contentProtectionElems,
      false,
      keySystemByURI
    );

    const language = language_utils.normalize(elem.getAttribute('lang') || 'und');

    // This attribute is currently non-standard, but it is supported by Kaltura.
    let label = elem.getAttribute('label');

    // See DASH IOP 4.3 here https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf (page 35)
    const labelElements = xml_utils.findChildren(elem, 'Label');
    if (labelElements && labelElements.length) {
      // NOTE: Right now only one label field is supported.
      const firstLabelElement = labelElements[0];
      if (firstLabelElement.textContent) {
        label = firstLabelElement.textContent;
      }
    }

    // Parse Representations into Streams.
    logger.sp_debug(filePath, "Starting parsing representations...");
    const representations = xml_utils.findChildren(elem, 'Representation');

    logger.sp_debug(filePath, "%d Representaion(s) found.", representations.length);

    const streams = representations.map((representation) => {
      const parsedRepresentation = this.parseRepresentation_(context,
        contentProtection, kind, language, label, main, roleValues, representation);
      if (parsedRepresentation) {
        parsedRepresentation.hdr = parsedRepresentation.hdr || videoRange;
      }

      return parsedRepresentation;
    }).filter((s) => !!s);

    if (streams.length == 0) {
      const isImage = context.adaptationSet.contentType == ContentType.IMAGE;
      // Ignore empty AdaptationSets if ignoreEmptyAdaptationSet is true
      // or they are for text/image content.
      if (isText || isImage) {
        return null;
      }
      throw new error(
        error.Severity.CRITICAL,
        error.Category.MANIFEST,
        error.Code.DASH_EMPTY_ADAPTATION_SET);
    }

    // If AdaptationSet's type is unknown or is ambiguously "application",
    // guess based on the information in the first stream.  If the attributes
    // mimeType and codecs are split across levels, they will both be inherited
    // down to the stream level by this point, so the stream will have all the
    // necessary information.
    if (!context.adaptationSet.contentType ||
      context.adaptationSet.contentType == ContentType.APPLICATION) {
      const mimeType = streams[0].mimeType;
      const codecs = streams[0].codecs;
      context.adaptationSet.contentType = dash_parser.guessContentType_(mimeType, codecs);

      for (const stream of streams) {
        stream.type = context.adaptationSet.contentType;
      }
    }

    for (const stream of streams) {
      // Some DRM license providers require that we have a default
      // key ID from the manifest in the wrapped license request.
      // Thus, it should be put in drmInfo to be accessible to request filters.
      for (const drmInfo of contentProtection.drmInfos) {
        drmInfo.keyIds = drmInfo.keyIds && stream.keyIds ?
          new Set([...drmInfo.keyIds, ...stream.keyIds]) :
          drmInfo.keyIds || stream.keyIds;
      }
    }

    logger.sp_debug(filePath, "Stream array created from representations, keyIds are re-configured.");

    const repIds = representations
      .map((node) => { return node.getAttribute('id'); })
      .filter(functional.isNotNull);
    logger.sp_debug(filePath, `Representation Ids: ${repIds}`);

    logger.sp_debug(filePath, `AdaptationSet parsing finished`);

    return {
      id: context.adaptationSet.id || ('__fake__' + this.globalId_++),
      contentType: context.adaptationSet.contentType,
      language: language,
      main: main,
      streams: streams,
      drmInfos: contentProtection.drmInfos,
      trickModeFor: trickModeFor,
      representationIds: repIds,
    };
  }

  /**
   * Parses a Representation XML element.
   * 
   * @param {dash_parser.context} context
   * @param {content_protection.context} contentProtection
   * @param {(string|undefined)} kind
   * @param {string} language
   * @param {string} label
   * @param {boolean} isPrimary
   * @param {!Array.<string>} roles
   * @param {!Element} node
   * @return {stream} The Stream, or null when there is a 
   *  non-critical parsing error.
   * @private
   */
  parseRepresentation_(context, contentProtection, kind, language, label,
    isPrimary, roles, node) {
    logger.sp_debug(filePath, "Parsing Representation...");

    const ContentType = manifest_parser_utils.ContentType;

    context.representation = this.createFrame_(node, context.adaptationSet, null);

    this.minTotalAvailabilityTimeOffest_ =
      Math.min(this.minTotalAvailabilityTimeOffest_,
        context.representation.availabilityTimeOffset);

    if (!this.verifyRepresentation_(context.representation)) {
      logger.sp_warn(filePath, 'Skipping representation %j', context.representation);
      return null;
    }

    const periodStart = context.periodInfo.start;
    // NOTE: bandwidth is a mandatory attribute according to the spec, and zero
    // does not make sense in the DASH spec's bandwidth formulas.
    // In some content, however, the attribute is missing or zero.
    // To avoid NaN at the variant level on broken content, fall back to zero.
    // https://github.com/shaka-project/shaka-player/issues/938#issuecomment-317278180
    context.bandwidth =
      xml_utils.parseAttr(node, 'bandwidth', xml_utils.parseInt) || 0;

    logger.sp_debug(filePath, `Detected bandwidth: ${context.bandwidth}`);

    let streamInfo;

    const contentType = context.representation.contentType;
    const isText = contentType == ContentType.TEXT ||
      contentType == ContentType.APPLICATION;
    const isImage = contentType == ContentType.IMAGE;

    try {
      const requestInitSegment = (uris, startByte, endByte) => {
        return this.requestInitSegment_(uris, startByte, endByte);
      };
      if (context.representation.segmentBase) {
        logger.sp_debug(filePath, "SegmentBase element exists, creating stream information using it...");
        streamInfo = segment_base.createStreamInfo(context, requestInitSegment);
      } else if (context.representation.segmentList) {
        logger.sp_debug(filePath, "SegmentList element exists, creating stream information using it...");
        streamInfo = segment_list.createStreamInfo(context, this.streamMap_);
      } else if (context.representation.segmentTemplate) {
        logger.sp_debug(filePath, "SegmentTemplate element exists, creating stream information using it...");
        const hasManifest = !!this.manifest_;

        streamInfo = segment_template.createStreamInfo(
          context, requestInitSegment, this.streamMap_, hasManifest,
          1000, this.periodDurations_
        );
      } else {
        assert(isText, 'Must have Segment* with non-text streams.');

        const baseUris = context.representation.baseUris;
        const duration = context.periodInfo.duration || 0;
        streamInfo = {
          generateSegmentIndex: () => {
            return Promise.resolve(segment_index.forSingleSegment(
              periodStart, duration, baseUris
            ));
          },
        };
      }
    } catch (err) {
      if ((isText || isImage) &&
        err.code == error.Code.DASH_NO_SEGMENT_INFO) {
        // Ignore any DASH_NO_SEGMENT_INFO errors for text/image
        // streams.
        return null;
      }

      // For anything else, re-throw.
      throw err;
    }

    const contentProtectionElems =
      xml_utils.findChildren(node, 'ContentProtection');

    const keyId = content_protection.parseFromRepresentation(
      contentProtectionElems, contentProtection,
      false, keySystemByURI);
    const keyIds = new Set(keyId ? [keyId] : []);
    logger.sp_debug(filePath, `keyID: ${[...keyIds].join(' ')}`);

    // Detect the presence of E-AC3 JOC audio content, using DD+JOC signaling.
    // See: ETSI TS 103 420 V1.2.1 (2018-10)
    const supplementalPropertyElems =
      xml_utils.findChildren(node, 'SupplementalProperty');
    const hasJoc = supplementalPropertyElems.some((element) => {
      const expectedUri = 'tag:dolby.com,2018:dash:EC3_ExtensionType:2018';
      const expectedValue = 'JOC';
      return element.getAttribute('schemeIdUri') == expectedUri &&
        element.getAttribute('value') == expectedValue;
    });
    let spatialAudio = false;
    if (hasJoc) {
      context.representation.mimeType = 'audio/eac3-joc';
      spatialAudio = true;
    }

    let forced = false;
    if (isText) {
      // See: https://github.com/shaka-project/shaka-player/issues/2122 and
      // https://github.com/Dash-Industry-Forum/DASH-IF-IOP/issues/165
      forced = roles.includes('forced_subtitle') ||
        roles.includes('forced-subtitle');
    }

    let tilesLayout;
    if (isImage) {
      const essentialPropertyElems =
        xml_utils.findChildren(node, 'EssentialProperty');
      const thumbnailTileElem = essentialPropertyElems.find((element) => {
        const expectedUris = [
          'http://dashif.org/thumbnail_tile',
          'http://dashif.org/guidelines/thumbnail_tile',
        ];
        return expectedUris.includes(element.getAttribute('schemeIdUri'));
      });
      if (thumbnailTileElem) {
        tilesLayout = thumbnailTileElem.getAttribute('value');
      }
      // Filter image adaptation sets that has no tilesLayout.
      if (!tilesLayout) {
        return null;
      }
    }

    let hdr;
    const profiles = context.profiles;
    const codecs = context.representation.codecs;

    const hevcHDR = 'http://dashif.org/guidelines/dash-if-uhd#hevc-hdr-pq10';
    if (profiles.includes(hevcHDR) && (codecs.includes('hvc1.2.4.L153.B0') ||
      codecs.includes('hev1.2.4.L153.B0'))) {
      hdr = 'PQ';
    }

    const contextId = context.representation.id ?
      context.period.id + ',' + context.representation.id : '';

    const stream = {
      id: this.globalId_++,
      originalId: context.representation.id,
      createSegmentIndex: async () => {
        // If we have a stream with the same context id stored in the map
        // that has no segmentIndex, we should set the segmentIndex for it.
        const storedInMap = contextId && context.dynamic &&
          this.streamMap_[contextId];

        const currentStream = storedInMap ? this.streamMap_[contextId] : stream;
        if (!currentStream.segmentIndex) {
          currentStream.segmentIndex = await streamInfo.generateSegmentIndex();
        }
      },

      closeSegmentIndex: () => {
        if (stream.segmentIndex) {
          stream.segmentIndex.release();
          stream.segmentIndex = null;
        }
      },
      segmentIndex: null,
      mimeType: context.representation.mimeType,
      codecs: context.representation.codecs,
      frameRate: context.representation.frameRate,
      pixelAspectRatio: context.representation.pixelAspectRatio,
      bandwidth: context.bandwidth,
      width: context.representation.width,
      height: context.representation.height,
      kind,
      encrypted: contentProtection.drmInfos.length > 0,
      drmInfos: contentProtection.drmInfos,
      keyIds,
      language,
      label,
      type: context.adaptationSet.contentType,
      primary: isPrimary,
      trickModeVideo: null,
      emsgSchemeIdUris:
        context.representation.emsgSchemeIdUris,
      roles,
      forced: forced,
      channelsCount: context.representation.numChannels,
      audioSamplingRate: context.representation.audioSamplingRate,
      spatialAudio: spatialAudio,
      hdr,
      tilesLayout,
      matchedStreams: [],
    };

    if (contextId && context.dynamic && !this.streamMap_[contextId]) {
      this.streamMap_[contextId] = stream;
    }

    logger.sp_debug(filePath, `Representation(id="${stream.originalId}") parsed, stream object is created and returning...`);

    return stream;
  }

  /**
   * Verifies that a Representation has exactly one Segment* element.  Prints
   * warnings if there is a problem.
   *
   * @param frame
   * @return {boolean} True if the Representation is usable; otherwise return
   *   false.
   * @private
   */
  verifyRepresentation_(frame) {
    const ContentType = manifest_parser_utils.ContentType;

    let n = 0;
    n += frame.segmentBase ? 1 : 0;
    n += frame.segmentList ? 1 : 0;
    n += frame.segmentTemplate ? 1 : 0;

    if (n == 0) {
      // TODO: Extend with the list of MIME types registered to TextEngine.
      if (frame.contentType == ContentType.TEXT ||
        frame.contentType == ContentType.APPLICATION) {
        return true;
      } else {
        logger.sp_warn(filePath,
          'Representation does not contain a segment information source:' +
          'the Representation must contain one of SegmentBase, SegmentList,' +
          'SegmentTemplate, or explicitly indicate that it is "text".',
          frame);
        return false;
      }
    }

    if (n != 1) {
      logger.sp_warn(filePath,
        'Representation contains multiple segment information sources:' +
        'the Representation should only contain one of SegmentBase,' +
        'SegmentList, or SegmentTemplate.',
        frame);
      if (frame.segmentBase) {
        logger.sp_log(filePath, 'Using SegmentBase by default.');
        frame.segmentList = null;
        frame.segmentTemplate = null;
      } else {
        assert(frame.segmentList, 'There should be a SegmentList');
        logger.sp_log(filePath, 'Using SegmentList by default.');
        frame.segmentTemplate = null;
      }
    }

    return true;
  }

  /**
   * Sets the update timer.  Does nothing if the manifest does not specify an
   * update period.
   *
   * @param {number} offset An offset, in seconds, to apply to the manifest's
   *   update period.
   * @private
   */
  setUpdateTimer_(offset) {
    // NOTE: An updatePeriod_ of -1 means the attribute was missing.
    // An attribute which is present and set to 0 should still result in
    // periodic updates.  For more, see:
    // https://github.com/shaka-project/shaka-player/issues/331
    if (this.updatePeriod_ < 0) {
      return;
    }

    const finalDelay = Math.max(
      dash_parser.MIN_UPDATE_PERIOD_,
      this.updatePeriod_ - offset,
      this.averageUpdateDuration_.getEstimate());

    // We do not run the timer as repeating because part of update is async and
    // we need schedule the update after it finished.
    this.updateTimer_.tickAfter(/* seconds= */ finalDelay);
  }

  /**
   * Creates a new inheritance frame for the given element.
   * 
   * @param element
   * @param {?dash_parser.InheritanceFrame} parent
   * @param {Array.<string>} baseUris // This will be removed, not used anymore
   * @return {dash_parser.InheritanceFrame}
   * @private
   */
  createFrame_(elem, parent, baseUris) {
    let elemParent = parent || ({
      contentType: '',
      mimeType: '',
      codecs: '',
      emsgSchemeIdUris: [],
      frameRate: undefined,
      pixelAspectRatio: undefined,
      numChannels: null,
      audioSamplingRate: null,
      availabilityTimeOffset: 0,
    });

    const parseNumber = xml_utils.parseNonNegativeInt;
    const evalDivision = xml_utils.evalDivision;

    const uriObjs = xml_utils.findChildren(elem, 'BaseURL');
    const uris = uriObjs.map(xml_utils.getContents);

    let elemBaseUris = parent === null ? uris :
      manifest_parser_utils.resolveUris(parent.baseUris, uris);

    let contentType = elem.getAttribute('contentType') || elemParent.contentType;
    const mimeType = elem.getAttribute('mimeType') || elemParent.mimeType;
    const codecs = elem.getAttribute('codecs') || elemParent.codecs;
    const frameRate =
      xml_utils.parseAttr(elem, 'frameRate', evalDivision) || elemParent.frameRate;
    const pixelAspectRatio =
      elem.getAttribute('sar') || elemParent.pixelAspectRatio;
    const emsgSchemeIdUris = this.emsgSchemeIdUris_(
      xml_utils.findChildren(elem, 'InbandEventStream'),
      elemParent.emsgSchemeIdUris);
    const audioChannelConfigs =
      xml_utils.findChildren(elem, 'AudioChannelConfiguration');
    const numChannels =
      this.parseAudioChannels_(audioChannelConfigs) || elemParent.numChannels;
    const audioSamplingRate =
      xml_utils.parseAttr(elem, 'audioSamplingRate', parseNumber) ||
      elemParent.audioSamplingRate;

    if (!contentType) {
      contentType = dash_parser.guessContentType_(mimeType, codecs);
    }

    const segmentBase = xml_utils.findChild(elem, 'SegmentBase');
    const segmentTemplate = xml_utils.findChild(elem, 'SegmentTemplate');

    // The availabilityTimeOffset is the sum of all @availabilityTimeOffset
    // values that apply to the adaptation set, via BaseURL, SegmentBase,
    // or SegmentTemplate elements.
    const segmentBaseAto = segmentBase ?
      (xml_utils.parseAttr(segmentBase, 'availabilityTimeOffset',
        xml_utils.parseFloat) || 0) : 0;
    const segmentTemplateAto = segmentTemplate ?
      (xml_utils.parseAttr(segmentTemplate, 'availabilityTimeOffset',
        xml_utils.parseFloat) || 0) : 0;
    const baseUriAto = uriObjs && uriObjs.length ?
      (xml_utils.parseAttr(uriObjs[0], 'availabilityTimeOffset',
        xml_utils.parseFloat) || 0) : 0;

    const availabilityTimeOffset = elemParent.availabilityTimeOffset + baseUriAto +
      segmentBaseAto + segmentTemplateAto;
    
    return {
      baseUris: elemBaseUris,
      segmentBase: segmentBase || elemParent.segmentBase,
      segmentList:
        xml_utils.findChild(elem, 'SegmentList') || elemParent.segmentList,
      segmentTemplate: segmentTemplate || elemParent.segmentTemplate,
      width: xml_utils.parseAttr(elem, 'width', parseNumber) || elemParent.width,
      height: xml_utils.parseAttr(elem, 'height', parseNumber) || elemParent.height,
      contentType: contentType,
      mimeType: mimeType,
      codecs: codecs,
      frameRate: frameRate,
      pixelAspectRatio: pixelAspectRatio,
      emsgSchemeIdUris: emsgSchemeIdUris,
      id: elem.getAttribute('id'),
      numChannels: numChannels,
      audioSamplingRate: audioSamplingRate,
      availabilityTimeOffset: availabilityTimeOffset,
    };
  }

  /**
   * Returns a new array of InbandEventStream schemeIdUri containing the union
   * of the ones parsed from inBandEventStreams and the ones provided in
   * emsgSchemeIdUris.
   * 
   * @param {!Array.<!Element>} inBandEventStreams Array of InbandEventStream
   *    elements to parse and add to the returned array.
   * @param {!Array.<string>} emsgSchemeIdUris Array of parsed
   *    InbandEventStream schemeIdUri attributes to add to the returned array.
   * @return {!Array.<string>} schemIdUris Array of parsed
   *    InbandEventStream schemeIdUri attributes.
   * @private
   */
  emsgSchemeIdUris_(inBandEventStreams, emsgSchemeIdUris) {
    const schemeIdUris = emsgSchemeIdUris.slice();
    for (const event of inBandEventStreams) {
      const schemeIdUri = event.getAttribute('schemeIdUri');
      if (!schemeIdUris.includes(schemeIdUri)) {
        schemeIdUris.push(schemeIdUri);
      }
    }
    return schemeIdUris;
  }

  /**
   * @param {!Array.<!Element>} audioChannelConfigs An array of
   *   AudioChannelConfiguration elements.
   * @return {?number} The number of audio channels, or null if unknown.
   * @private
   */
  parseAudioChannels_(audioChannelConfigs) {
    for (const elem of audioChannelConfigs) {
      const scheme = elem.getAttribute('schemeIdUri');
      if (!scheme) {
        continue;
      }

      const value = elem.getAttribute('value');
      if (!value) {
        continue;
      }

      switch (scheme) {
        case 'urn:mpeg:dash:outputChannelPositionList:2012':
          // A space-separated list of speaker positions, so the number of
          // channels is the length of this list.
          return value.trim().split(/ +/).length;

        case 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011':
        case 'urn:dts:dash:audio_channel_configuration:2012': {
          // As far as we can tell, this is a number of channels.
          const intValue = parseInt(value, 10);
          if (!intValue) {  // 0 or NaN
            logger.sp_warn(filePath, 'Channel parsing failure! ' +
              'Ignoring scheme and value', scheme, value);
            continue;
          }
          return intValue;
        }

        case 'tag:dolby.com,2014:dash:audio_channel_configuration:2011':
        case 'urn:dolby:dash:audio_channel_configuration:2011': {
          // A hex-encoded 16-bit integer, in which each bit represents a
          // channel.
          let hexValue = parseInt(value, 16);
          if (!hexValue) {  // 0 or NaN
            logger.sp_warn(filePath, 'Channel parsing failure! ' +
              'Ignoring scheme and value', scheme, value);
            continue;
          }
          // Count the 1-bits in hexValue.
          let numBits = 0;
          while (hexValue) {
            if (hexValue & 1) {
              ++numBits;
            }
            hexValue >>= 1;
          }
          return numBits;
        }

        // Defined by https://dashif.org/identifiers/audio_source_metadata/ and clause 8.2, in ISO/IEC 23001-8.
        case 'urn:mpeg:mpegB:cicp:ChannelConfiguration': {
          const noValue = 0;
          const channelCountMapping = [
            noValue, 1, 2, 3, 4, 5, 6, 8, 2, 3, /* 0--9 */
            4, 7, 8, 24, 8, 12, 10, 12, 14, 12, /* 10--19 */
            14, /* 20 */
          ];
          const intValue = parseInt(value, 10);
          if (!intValue) {  // 0 or NaN
            logger.sp_warn(filePath, 'Channel parsing failure! ' +
              'Ignoring scheme and value', scheme, value);
            continue;
          }
          if (intValue > noValue && intValue < channelCountMapping.length) {
            return channelCountMapping[intValue];
          }
          continue;
        }

        default:
          logger.sp_warn(filePath, 'Unrecognized audio channel scheme:', scheme, value);
          continue;
      }
    }

    return null;
  }

  /**
   * Makes a network request on behalf of segment_base.createStreamInfo.
   */
  async requestInitSegment_(uris, startByte, endByte) {
    logger.sp_debug(filePath, "Fetching segment... URI: ", uris);
    // Will be added later.
  }

  /**
   * Called when the update timer ticks.
   *
   * @return {!Promise}
   * @private
   */
  async onUpdate_() {
    assert(this.updatePeriod_ >= 0,
      'There should be an update period');

    // Default the update delay to 1 seconds so that manifest is updated every one
    // second is elapsed, original vaule was 0, but changed for our case.
    let updateDelay = 1;

    /**
     * Check if current time is before the expire time which we
     * got from manifest API.
     */
    let currentTimeInSecond = Math.round((Date.now()) / 1000);
    if (currentTimeInSecond >= this.expireTime_) {
      logger.sp_warn(filePath, 'Manifest is expired, re-fetching manifest URI...');
      await this.getManifestURI_(this.apiURLFormat_, this.serviceId_, this.id_);
      this.manifestExpired = true;

      try {
        updateDelay = await this.requestManifest_();
      } catch (err) {
        assert(err instanceof error, 'should only receives sp error');

        // Try updating again, but ensure we haven't been destroyed.
        err.severity = error.Severity.RECOVERABLE;
      }
    }

    this.setUpdateTimer_(updateDelay);
  }

  /**
   * Guess the content type based on MIME type and codecs.
   *
   * @param {string} mimeType
   * @param {string} codecs
   * @return {string}
   * @private
   */
  static guessContentType_(mimeType, codecs) {
    const fullMimeType = mime_utils.getFullType(mimeType, codecs);

    if (text_engine.isTypeSupported(fullMimeType)) {
      // If it's supported by TextEngine, it's definitely text.
      // We don't check MediaSourceEngine, because that would report support
      // for platform-supported video and audio types as well.
      return manifest_parser_utils.ContentType.TEXT;
    }

    // Otherwise, just split the MIME type.  This handles video and audio
    // types well.
    return mimeType.split('/')[0];
  }

  /**
   * Makes a request to the given URI and calculates the clock offset.
   *
   * @param {!Array.<string>} baseUris
   * @param {string} uri
   * @param {string} method
   * @return {!Promise.<number>}
   * @private
   */
  async requestForTiming_(baseUris, uri, method) {
    const requestUris =
      manifest_parser_utils.resolveUris(baseUris, [uri]);

    const response = await network_engine.http_get(requestUris[0]);
    let text;
    if (method == 'HEAD') {
      if (!response.headers || !response.headers['date']) {
        logger.sp_warn(filePath, 'UTC timing response is missing',
          'expected date header');
        return 0;
      }
      text = response.headers['date'];
    } else {
      text = string_utils.fromUTF8(response.data);
    }
    const date = Date.parse(text);
    if (isNaN(date)) {
      logger.sp_warn(filePath, 'Unable to parse date from UTC timing response');
      return 0;
    }
    return (date - Date.now());
  }

  /**
   * Parses an array of UTCTiming elements.
   *
   * @param {!Array.<string>} baseUris
   * @param {!Array.<!Element>} elems
   * @return {!Promise.<number>}
   * @private
   */
  async parseUtcTiming_(baseUris, elems) {
    const schemesAndValues = elems.map((elem) => {
      return {
        scheme: elem.getAttribute('schemeIdUri'),
        value: elem.getAttribute('value'),
      };
    });

    // If there's nothing specified in the manifest, but we have a default from
    // the config, use that.
    const clockSyncUri = '';
    if (!schemesAndValues.length && clockSyncUri) {
      schemesAndValues.push({
        scheme: 'urn:mpeg:dash:utc:http-head:2014',
        value: clockSyncUri,
      });
    }

    for (const sv of schemesAndValues) {
      try {
        const scheme = sv.scheme;
        const value = sv.value;
        switch (scheme) {
          // See DASH IOP Guidelines Section 4.7
          // https://bit.ly/DashIop3-2
          // Some old ISO23009-1 drafts used 2012.
          case 'urn:mpeg:dash:utc:http-head:2014':
          case 'urn:mpeg:dash:utc:http-head:2012':
            // eslint-disable-next-line no-await-in-loop
            return await this.requestForTiming_(baseUris, value, 'HEAD');
          case 'urn:mpeg:dash:utc:http-xsdate:2014':
          case 'urn:mpeg:dash:utc:http-iso:2014':
          case 'urn:mpeg:dash:utc:http-xsdate:2012':
          case 'urn:mpeg:dash:utc:http-iso:2012':
            // eslint-disable-next-line no-await-in-loop
            return await this.requestForTiming_(baseUris, value, 'GET');
          case 'urn:mpeg:dash:utc:direct:2014':
          case 'urn:mpeg:dash:utc:direct:2012': {
            const date = Date.parse(value);
            return isNaN(date) ? 0 : (date - Date.now());
          }

          case 'urn:mpeg:dash:utc:http-ntp:2014':
          case 'urn:mpeg:dash:utc:ntp:2014':
          case 'urn:mpeg:dash:utc:sntp:2014':
            logger.sp_warn(filePath, 'NTP UTCTiming scheme is not supported');
            break;
          default:
            logger.sp_warn(filePath,
              'Unrecognized scheme in UTCTiming element', scheme);
            break;
        }
      } catch (e) {
        logger.sp_warn(filePath, 'Error fetching time from UTCTiming elem', e.message);
      }
    }

    logger.sp_warn(filePath,
      'A UTCTiming element should always be given in live manifests! ' +
      'This content may not play on clients with bad clocks!');
    return 0;
  }

}

/**
 * Contains the minimum amount of time, in seconds, between manifest update
 * requests.
 *
 * @private
 * @const {number}
 */
dash_parser.MIN_UPDATE_PERIOD_ = 3;


/**
 * @typedef {
 *   function(!Array.<string>, ?number, ?number):!Promise.<BufferSource>
 * }
 */
dash_parser.RequestInitSegmentCallback;


/**
 * @typedef {{
 *   segmentBase: Element,
 *   segmentList: Element,
 *   segmentTemplate: Element,
 *   baseUris: !Array.<string>,
 *   width: (number|undefined),
 *   height: (number|undefined),
 *   contentType: string,
 *   mimeType: string,
 *   codecs: string,
 *   frameRate: (number|undefined),
 *   pixelAspectRatio: (string|undefined),
 *   emsgSchemeIdUris: !Array.<string>,
 *   id: ?string,
 *   numChannels: ?number,
 *   audioSamplingRate: ?number,
 *   availabilityTimeOffset: number
 * }}
 *
 * @description
 * A collection of elements and properties which are inherited across levels
 * of a DASH manifest.
 *
 * @property {Element} segmentBase
 *   The XML node for SegmentBase.
 * @property {Element} segmentList
 *   The XML node for SegmentList.
 * @property {Element} segmentTemplate
 *   The XML node for SegmentTemplate.
 * @property {!Array.<string>} baseUris
 *   An array of absolute base URIs for the frame.
 * @property {(number|undefined)} width
 *   The inherited width value.
 * @property {(number|undefined)} height
 *   The inherited height value.
 * @property {string} contentType
 *   The inherited media type.
 * @property {string} mimeType
 *   The inherited MIME type value.
 * @property {string} codecs
 *   The inherited codecs value.
 * @property {(number|undefined)} frameRate
 *   The inherited framerate value.
 * @property {(string|undefined)} pixelAspectRatio
 *   The inherited pixel aspect ratio value.
 * @property {!Array.<string>} emsgSchemeIdUris
 *   emsg registered schemeIdUris.
 * @property {?string} id
 *   The ID of the element.
 * @property {?number} numChannels
 *   The number of audio channels, or null if unknown.
 * @property {?number} audioSamplingRate
 *   Specifies the maximum sampling rate of the content, or null if unknown.
 * @property {number} availabilityTimeOffset
 *   Specifies the total availabilityTimeOffset of the segment, or 0 if unknown.
 */
dash_parser.InheritanceFrame;


/**
 * @typedef {{
 *   dynamic: boolean,
 *   presentationTimeline: !presentation_timeline,
 *   period: ?dash_parser.InheritanceFrame,
 *   periodInfo: ?dash_parser.PeriodInfo,
 *   adaptationSet: ?dash_parser.InheritanceFrame,
 *   representation: ?dash_parser.InheritanceFrame,
 *   bandwidth: number,
 *   indexRangeWarningGiven: boolean,
 *   availabilityTimeOffset: number,
 *   profiles: !Array.<string>
 * }}
 *
 * @description
 * Contains context data for the streams.  This is designed to be
 * shallow-copyable, so the parser must overwrite (not modify) each key as the
 * parser moves through the manifest and the parsing context changes.
 *
 * @property {boolean} dynamic
 *   True if the MPD is dynamic (not all segments available at once)
 * @property {!presentation_timeline} presentationTimeline
 *   The PresentationTimeline.
 * @property {?dash_parser.InheritanceFrame} period
 *   The inheritance from the Period element.
 * @property {?dash_parser.PeriodInfo} periodInfo
 *   The Period info for the current Period.
 * @property {?dash_parser.InheritanceFrame} adaptationSet
 *   The inheritance from the AdaptationSet element.
 * @property {?dash_parser.InheritanceFrame} representation
 *   The inheritance from the Representation element.
 * @property {number} bandwidth
 *   The bandwidth of the Representation, or zero if missing.
 * @property {boolean} indexRangeWarningGiven
 *   True if the warning about SegmentURL@indexRange has been printed.
 * @property {number} availabilityTimeOffset
 *   The sum of the availabilityTimeOffset values that apply to the element.
 * @property {!Array.<string>} profiles
 *   Profiles of DASH are defined to enable interoperability and the signaling
 *   of the use of features.
 */
dash_parser.Context;


/**
 * @typedef {{
 *   start: number,
 *   duration: ?number,
 *   node: !Element,
 *   isLastPeriod: boolean
 * }}
 *
 * @description
 * Contains information about a Period element.
 *
 * @property {number} start
 *   The start time of the period.
 * @property {?number} duration
 *   The duration of the period; or null if the duration is not given.  This
 *   will be non-null for all periods except the last.
 * @property {!Element} node
 *   The XML Node for the Period.
 * @property {boolean} isLastPeriod
 *   Whether this Period is the last one in the manifest.
 */
dash_parser.PeriodInfo;


/**
 * @typedef {{
 *   id: string,
 *   contentType: ?string,
 *   language: string,
 *   main: boolean,
 *   streams: !Array.<Stream>,
 *   drmInfos: !Array.<DrmInfo>,
 *   trickModeFor: ?string,
 *   representationIds: !Array.<string>
 * }}
 *
 * @description
 * Contains information about an AdaptationSet element.
 *
 * @property {string} id
 *   The unique ID of the adaptation set.
 * @property {?string} contentType
 *   The content type of the AdaptationSet.
 * @property {string} language
 *   The language of the AdaptationSet.
 * @property {boolean} main
 *   Whether the AdaptationSet has the 'main' type.
 * @property {!Array.<Stream>} streams
 *   The streams this AdaptationSet contains.
 * @property {!Array.<DrmInfo>} drmInfos
 *   The DRM info for the AdaptationSet.
 * @property {?string} trickModeFor
 *   If non-null, this AdaptationInfo represents trick mode tracks.  This
 *   property is the ID of the normal AdaptationSet these tracks should be
 *   associated with.
 * @property {!Array.<string>} representationIds
 *   An array of the IDs of the Representations this AdaptationSet contains.
 */
dash_parser.AdaptationInfo;


/**
 * @typedef {function():!Promise.<segment_index>}
 * @description
 * An async function which generates and returns a SegmentIndex.
 */
dash_parser.GenerateSegmentIndexFunction;


/**
 * @typedef {{
 *   generateSegmentIndex:dash_parser.GenerateSegmentIndexFunction
 * }}
 *
 * @description
 * Contains information about a Stream. This is passed from the createStreamInfo
 * methods.
 *
 * @property {dash_parser.GenerateSegmentIndexFunction}
 *     generateSegmentIndex
 *   An async function to create the SegmentIndex for the stream.
 */
dash_parser.StreamInfo;

manifest_parser.registerParserByExtension(
  'mpd', () => new dash_parser());
manifest_parser.registerParserByMime(
  'application/dash+xml', () => new dash_parser());
manifest_parser.registerParserByMime(
  'video/vnd.mpeg.dash.mpd', () => new dash_parser());

export default dash_parser;