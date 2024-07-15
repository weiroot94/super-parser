import logger from '../src/util/sp_logger.js';

logger.sp_log(import.meta.url, "log num is %d, logger name is %s", 567, "supper parser logger");
logger.sp_warn(import.meta.url, "log num is %d, logger name is %s", 567, "supper parser logger");
logger.sp_error(import.meta.url, "log num is %d, logger name is %s", 567, "supper parser logger");
