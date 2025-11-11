const fs = require('fs');
const path = require('path');
const config = require('../config');

const resolveLogPath = () => {
    let baseDir = config.logger.logDirectory ?
        config.logger.logDirectory :
        path.join(__dirname, '..');

    try {
        fs.mkdirSync(baseDir, { recursive: true });
    } catch (_err) {
        // Ignore mkdir errors; appendFile will surface issues later
    }

    return path.join(baseDir, 'splitmerge.log');
};

const splitLogPath = resolveLogPath();

function append(line) {
    const timestamp = new Date().toISOString();
    const entry = `${timestamp} ${line}\n`;
    fs.appendFile(splitLogPath, entry, err => {
        if (err) {
            // eslint-disable-next-line no-console
            console.warn(`Cannot write split log: ${err.message}`);
        }
    });
}

module.exports = {
    append
};
