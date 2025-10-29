/**
 *  ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM
 *  Copyright (C) 2018-present MasseranoLabs LLC
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
"use strict";

let config = require('../config');
let winston = require('winston');
let fs = require('fs');
let path = require('path');
const package_info = require('../package_info');

// Set up logging
// Configure custom File transport to write plain text messages
let logPath = ( config.logger.logDirectory ? 
				config.logger.logDirectory : 
				path.join(__dirname, "..") );

// Check that log file directory can be written to
try {
	fs.accessSync(logPath, fs.W_OK);
} catch (e) {
	console.log( "Log directory '" + logPath + "' cannot be written to"  );
	throw e;
}
logPath += path.sep;
logPath += package_info.name + ".log";

let transports = [];
const logFormat = winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(info => {
        const { timestamp, level, message, stack } = info;
        const splatValues = info[Symbol.for('splat')] || [];
        const extra = splatValues.map(value => {
            if (typeof value === 'string') return value;
            try {
                return JSON.stringify(value);
            } catch (e) {
                return String(value);
            }
        }).join(' ');
        const extraStr = extra ? ' ' + extra : '';
        return `${timestamp} ${level}: ${stack || message}${extraStr}`;
    })
);

if (!config.deamon){
    transports.push(new winston.transports.Console({ level: config.logger.level, format: logFormat }));
}

let logger = winston.createLogger({
    level: config.logger.level,
    format: logFormat,
    transports
});

logger.add(new winston.transports.File({
        filename: logPath, // Write to projectname.log
        maxsize: config.logger.maxFileSize, // Max size of each file
        maxFiles: config.logger.maxFiles, // Max number of files
        level: config.logger.level // Level of log messages
    }));

module.exports = logger;
