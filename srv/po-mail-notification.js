'use strict';

/**
 * CAP wiring for srv/po-mail-notification.cds.
 *
 * Intentionally a one-liner: the whole feature lives in the isolated
 * /po-mail-notification folder so nothing in the existing services, db model
 * or shared mail code is touched.
 */

module.exports = require('../po-mail-notification/handlers/poMailNotificationHandler');