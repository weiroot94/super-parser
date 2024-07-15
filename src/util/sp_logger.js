import winston from 'winston';
import fs from 'fs';
import path from 'path';
import appRoot from 'app-root-path';
import { fileURLToPath } from 'url';

class sp_logger {
  constructor() {
    let format = winston.format;
    const { combine, timestamp, printf } = format;
    const spLogFormat = printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level}] [${message}]`;
    });

    let logDir = appRoot.path + "/log";

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir);
    }

    this.logger_ = winston.createLogger({
      exitOnError: false,
      transports: [
        new winston.transports.Console({
          colorize: 'true',
          format: combine(
            timestamp({
              format: 'YYYY/MM/DD hh:mm:ss.SSS A',
            }),
            format.colorize(),
            format.splat(),
            spLogFormat
          ),
        }),
        new winston.transports.File({
          filename: path.join(logDir, '/sp.log'),
          colorize: false,
          level: 'info',
          format: combine(
            timestamp({
              format: 'YYYY/MM/DD hh:mm:ss.SSS A',
            }),
            format.splat(),
            spLogFormat
          ),
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({ filename: path.join(logDir, '/rejection.log') })
      ]
    });
  }

  sp_log(path, format, ...logArgs) {
    this.logger_.info(this.get_end_path_only_(path) + ": " + format, ...logArgs);
  }

  sp_warn(path, format, ...logArgs) {
    this.logger_.warn(this.get_end_path_only_(path) + ": " + format, ...logArgs);
  }

  sp_error(path, format, ...logArgs) {
    this.logger_.error(this.get_end_path_only_(path) + ": " + format, ...logArgs);
  }

  sp_debug(path, format, ...logArgs) {
    this.logger_.debug(this.get_end_path_only_(path) + ": " + format, ...logArgs);
  }

  get_end_path_only_(path) {
    if (!path) {
      return "";
    }
    let absLogPath = fileURLToPath(path);
    let rootPath = appRoot.path;
    return absLogPath.replace(rootPath + "/", '').replace('.js', '');
  }

}

export default new sp_logger();
