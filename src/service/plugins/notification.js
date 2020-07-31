'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;
const NotificationUI = imports.service.ui.notification;


var Metadata = {
    label: _('Notifications'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Notification',
    incomingCapabilities: [
        'kdeconnect.notification',
        'kdeconnect.notification.request'
    ],
    outgoingCapabilities: [
        'kdeconnect.notification',
        'kdeconnect.notification.action',
        'kdeconnect.notification.reply',
        'kdeconnect.notification.request'
    ],
    actions: {
        withdrawNotification: {
            label: _('Cancel Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.notification']
        },
        closeNotification: {
            label: _('Close Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.notification.request']
        },
        replyNotification: {
            label: _('Reply Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('(ssa{ss})'),
            incoming: ['kdeconnect.notification'],
            outgoing: ['kdeconnect.notification.reply']
        },
        sendNotification: {
            label: _('Send Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('a{sv}'),
            incoming: [],
            outgoing: ['kdeconnect.notification']
        },
        activateNotification: {
            label: _('Activate Notification'),
            icon_name: 'preferences-system-notifications-symbolic',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: [],
            outgoing: ['kdeconnect.notification.action']
        }
    }
};


// A regex for our custom notificaiton ids
const ID_REGEX = /^(fdo|gtk)\|([^|]+)\|(.*)$/;

// A list of known SMS apps
const SMS_APPS = [
    // Popular apps that don't contain the string 'sms'
    'com.android.messaging',                    // AOSP
    'com.google.android.apps.messaging',        // Google Messages
    'com.textra',                               // Textra
    'xyz.klinker.messenger',                    // Pulse
    'com.calea.echo',                           // Mood Messenger
    'com.moez.QKSMS',                           // QKSMS
    'rpkandrodev.yaata',                        // YAATA
    'com.tencent.mm',                           // WeChat
    'com.viber.voip',                           // Viber
    'com.kakao.talk',                           // KakaoTalk
    'com.concentriclivers.mms.com.android.mms', // AOSP Clone
    'fr.slvn.mms',                              // AOSP Clone
    'com.promessage.message',                   //
    'com.htc.sense.mms',                        // HTC Messages

    // Known not to work with sms plugin
    'org.thoughtcrime.securesms',               // Signal Private Messenger
    'com.samsung.android.messaging'             // Samsung Messages
];


/**
 * Try to determine if an notification is from an SMS app
 *
 * @param {Core.Packet} - A `kdeconnect.notification`
 * @return {boolean} Whether the notification is from an SMS app
 */
function _isSmsNotification(packet) {
    let id = packet.body.id;

    if (id.includes('sms'))
        return true;

    for (let i = 0, len = SMS_APPS.length; i < len; i++) {
        if (id.includes(SMS_APPS[i]))
            return true;
    }

    return false;
}


/**
 * Notification Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/notifications
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sendnotifications
 */
var Plugin = GObject.registerClass({
    GTypeName: 'GSConnectNotificationPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'notification');

        this._session = this.service.components.get('session');

        // Load application notification settings
        this._applicationsChangedId = this.settings.connect(
            'changed::applications',
            this._onApplicationsChanged.bind(this)
        );
        this._onApplicationsChanged(this.settings, 'applications');
        this._applicationsChangedSkip = false;
    }

    connected() {
        super.connected();

        this._requestNotifications();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.notification':
                this._handleNotification(packet);
                break;

            // TODO
            case 'kdeconnect.notification.action':
                this._handleNotificationAction(packet);
                break;

            // No Linux/BSD desktop notifications are repliable as yet
            case 'kdeconnect.notification.reply':
                debug(`Not implemented: ${packet.type}`);
                break;

            case 'kdeconnect.notification.request':
                this._handleNotificationRequest(packet);
                break;

            default:
                debug(`Unknown notification packet: ${packet.type}`);
        }
    }

    _onApplicationsChanged(settings, key) {
        if (this._applicationsChangedSkip)
            return;

        try {
            let json = settings.get_string(key);
            this._applications = JSON.parse(json);
        } catch (e) {
            debug(e, this.device.name);

            this._applicationsChangedSkip = true;
            settings.set_string(key, '{}');
            this._applicationsChangedSkip = false;
        }
    }

    /**
     * Handle an incoming notification or closed report.
     *
     * FIXME: upstream kdeconnect-android is tagging many notifications as
     *        `silent`, causing them to never be shown. Since we already handle
     *        duplicates in the Shell, we ignore that flag for now.
     *
     * @param {Core.Packet} packet - A `kdeconnect.notification`
     */
    _handleNotification(packet) {
        // A report that a remote notification has been dismissed
        if (packet.body.hasOwnProperty('isCancel'))
            this.device.hideNotification(packet.body.id);

        // A normal, remote notification
        else
            this._receiveNotification(packet);
    }

    /**
     * Handle an incoming request to activate a notification action.
     *
     * @param {Core.Packet} packet - A `kdeconnect.notification.action`
     */
    _handleNotificationAction(packet) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Handle an incoming request to close or list notifications.
     *
     * @param {Core.Packet} packet - A `kdeconnect.notification.request`
     */
    _handleNotificationRequest(packet) {
        // A request for our notifications. This isn't implemented and would be
        // pretty hard to without communicating with GNOME Shell.
        if (packet.body.hasOwnProperty('request')) {
            return;

        // A request to close a local notification
        //
        // TODO: kdeconnect-android doesn't send these, and will instead send a
        // kdeconnect.notification packet with isCancel and an id of "0".
        //
        // For clients that do support it, we report notification ids in the
        // form "type|application-id|notification-id" so we can close it with
        // the appropriate service.
        } else if (packet.body.hasOwnProperty('cancel')) {
            let [, type, application, id] = ID_REGEX.exec(packet.body.cancel);

            if (type === 'fdo')
                this.service.remove_notification(parseInt(id));
            else if (type === 'gtk')
                this.service.remove_notification(id, application);
        }
    }

    /**
     * Upload an icon from a GLib.Bytes object.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {GLib.Bytes} bytes - The icon bytes
     */
    _uploadBytesIcon(packet, bytes) {
        let stream = Gio.MemoryInputStream.new_from_bytes(bytes);
        this._uploadIconStream(packet, stream, bytes.get_size());
    }

    /**
     * Upload an icon from a Gio.File object.
     *
     * @param {Core.Packet} packet - A `kdeconnect.notification`
     * @param {Gio.File} file - A file object for the icon
     */
    async _uploadFileIcon(packet, file) {
        let read = new Promise((resolve, reject) => {
            file.read_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
                try {
                    resolve(file.read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        let query = new Promise((resolve, reject) => {
            file.query_info_async(
                'standard::size',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (file, res) => {
                    try {
                        resolve(file.query_info_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        let [stream, info] = await Promise.all([read, query]);

        this._uploadIconStream(packet, stream, info.get_size());
    }

    /**
     * A function for uploading GThemedIcons
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.ThemedIcon} file - The GIcon to upload
     */
    _uploadThemedIcon(packet, icon) {
        let theme = Gtk.IconTheme.get_default();
        let file = null;

        for (let name of icon.names) {
            // NOTE: kdeconnect-android doesn't support SVGs
            let size = Math.max.apply(null, theme.get_icon_sizes(name));
            let info = theme.lookup_icon(name, size, Gtk.IconLookupFlags.NO_SVG);

            // Send the first icon we find from the options
            if (info) {
                file = Gio.File.new_for_path(info.get_filename());
                break;
            }
        }

        if (file)
            this._uploadFileIcon(packet, file);
        else
            this.device.sendPacket(packet);
    }

    /**
     * All icon types end up being uploaded in this function.
     *
     * @param {Core.Packet} packet - The packet for the notification
     * @param {Gio.InputStream} stream - A stream to read the icon bytes from
     * @param {number} size - Size of the icon in bytes
     */
    async _uploadIconStream(packet, stream, size) {
        try {
            let transfer = this.device.createTransfer({
                input_stream: stream,
                size: size
            });

            let success = await transfer.upload(packet);

            if (!success)
                this.device.sendPacket(packet);
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Upload an icon from a GIcon or themed icon name.
     *
     * @param {Core.Packet} packet - A `kdeconnect.notification`
     * @param {Gio.Icon|string|null} icon - An icon or %null
     */
    _uploadIcon(packet, icon = null) {
        // Normalize strings into GIcons
        if (typeof icon === 'string')
            icon = Gio.Icon.new_for_string(icon);

        if (icon instanceof Gio.ThemedIcon)
            return this._uploadThemedIcon(packet, icon);

        if (icon instanceof Gio.FileIcon)
            return this._uploadFileIcon(packet, icon.get_file());

        if (icon instanceof Gio.BytesIcon)
            return this._uploadBytesIcon(packet, icon.get_bytes());

        return this.device.sendPacket(packet);
    }

    /**
     * This is called by the notification listener.
     * See Notification.Listener._sendNotification()
     *
     * TODO: component signal - NotificationListener::notification-added
     */
    async sendNotification(notif) {
        try {
            if (!this.settings.get_boolean('send-notifications'))
                return;

            // Sending when the session is active is forbidden
            if (!this.settings.get_boolean('send-active') && this._session.active)
                return;

            // An unconfigured application
            // TODO: revisit application notification settings
            if (!this._applications.hasOwnProperty(notif.appName)) {
                this._applications[notif.appName] = {
                    iconName: 'system-run-symbolic',
                    enabled: true
                };

                // Store the themed icons for the device preferences window
                if (typeof notif.icon === 'string') {
                    this._applications[notif.appName].iconName = notif.icon;
                } else if (notif.icon instanceof Gio.ThemedIcon) {
                    let iconName = notif.icon.get_names()[0];
                    this._applications[notif.appName].iconName = iconName;
                }

                this._applicationsChangedSkip = true;
                this.settings.set_string(
                    'applications',
                    JSON.stringify(this._applications)
                );
                this._applicationsChangedSkip = false;
            }

            // An enabled application
            if (this._applications[notif.appName].enabled) {
                let icon = notif.icon || null;
                delete notif.icon;

                let packet = {
                    type: 'kdeconnect.notification',
                    body: notif
                };

                await this._uploadIcon(packet, icon);
            }
        } catch (e) {
            logError(e);
        }
    }

    async _downloadIcon(packet) {
        try {
            if (!packet.hasPayload())
                return null;

            // Save the file in the global cache
            let path = GLib.build_filenamev([
                gsconnect.cachedir,
                packet.body.payloadHash || `${Date.now()}`
            ]);

            // Check if we've already downloaded this icon
            let file = Gio.File.new_for_path(path);

            if (file.query_exists(null))
                return new Gio.FileIcon({file: file});

            // Open the file
            let stream = await new Promise((resolve, reject) => {
                file.replace_async(null, false, 2, 0, null, (file, res) => {
                    try {
                        resolve(file.replace_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // Download the icon
            let transfer = this.device.createTransfer(Object.assign({
                output_stream: stream,
                size: packet.payloadSize
            }, packet.payloadTransferInfo));

            // Return the icon if successful, delete on failure
            let success = await transfer.download();

            if (success)
                return new Gio.FileIcon({file: file});

            file.delete_async(GLib.PRIORITY_DEFAULT, null, null);

            return null;
        } catch (e) {
            debug(e, this.device.name);
            return null;
        }
    }

    /**
     * Receive an incoming notification.
     *
     * @param {Core.Packet} packet - A `kdeconnect.notification`
     */
    async _receiveNotification(packet) {
        try {
            // Set defaults
            let action = null;
            let buttons = [];
            let id = packet.body.id;
            let title = packet.body.appName;
            let body = `${packet.body.title}: ${packet.body.text}`;
            let icon = await this._downloadIcon(packet);

            // Repliable Notification
            if (packet.body.requestReplyId) {
                id = `${packet.body.id}|${packet.body.requestReplyId}`;
                action = {
                    name: 'replyNotification',
                    parameter: new GLib.Variant('(ssa{ss})', [
                        packet.body.requestReplyId,
                        '',
                        {
                            appName: packet.body.appName,
                            title: packet.body.title,
                            text: packet.body.text
                        }
                    ])
                };
            }

            // Notification Actions
            if (packet.body.actions) {
                buttons = packet.body.actions.map(action => {
                    return {
                        label: action,
                        action: 'activateNotification',
                        parameter: new GLib.Variant('(ss)', [id, action])
                    };
                });
            }

            // Special case for Missed Calls
            if (packet.body.id.includes('MissedCall')) {
                title = packet.body.title;
                body = packet.body.text;

                if (icon === null)
                    icon = new Gio.ThemedIcon({name: 'call-missed-symbolic'});

            // Special case for SMS notifications
            } else if (_isSmsNotification(packet)) {
                title = packet.body.title;
                body = packet.body.text;
                action = {
                    name: 'replySms',
                    parameter: new GLib.Variant('s', packet.body.title)
                };

                if (icon === null)
                    icon = new Gio.ThemedIcon({name: 'sms-symbolic'});

            // Special case where 'appName' is the same as 'title'
            } else if (packet.body.appName === packet.body.title) {
                body = packet.body.text;
            }

            // Use the device icon if we still don't have one
            if (icon === null)
                icon = new Gio.ThemedIcon({name: this.device.icon_name});

            // Show the notification
            this.device.showNotification({
                id: id,
                title: title,
                body: body,
                icon: icon,
                action: action,
                buttons: buttons
            });
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Request the remote notifications be sent
     */
    _requestNotifications() {
        this.device.sendPacket({
            type: 'kdeconnect.notification.request',
            body: {request: true}
        });
    }

    /**
     * Report that a local notification has been closed/dismissed.
     * TODO: kdeconnect-android doesn't handle incoming isCancel packets.
     *
     * @param {string} id - The local notification id
     */
    withdrawNotification(id) {
        this.device.sendPacket({
            type: 'kdeconnect.notification',
            body: {
                isCancel: true,
                id: id
            }
        });
    }

    /**
     * Close a remote notification.
     * TODO: ignore local notifications
     *
     * @param {string} id - The remote notification id
     */
    closeNotification(id) {
        this.device.sendPacket({
            type: 'kdeconnect.notification.request',
            body: {cancel: id}
        });
    }

    /**
     * Reply to a notification sent with a requestReplyId UUID
     *
     * @param {string} uuid - The requestReplyId for the repliable notification
     * @param {string} message - The message to reply with
     * @param {Object} notification - The original notification packet
     */
    replyNotification(uuid, message, notification) {
        // If the message has no content, open a dialog for the user to add one
        if (!message) {
            let dialog = new NotificationUI.ReplyDialog({
                device: this.device,
                uuid: uuid,
                notification: notification,
                plugin: this
            });
            dialog.present();

        // Otherwise just send the reply
        } else {
            this.device.sendPacket({
                type: 'kdeconnect.notification.reply',
                body: {
                    requestReplyId: uuid,
                    message: message
                }
            });
        }
    }

    /**
     * Activate a remote notification action
     *
     * @param {string} id - The remote notification id
     * @param {string} action - The notification action (label)
     */
    activateNotification(id, action) {
        this.device.sendPacket({
            type: 'kdeconnect.notification.action',
            body: {
                action: action,
                key: id
            }
        });
    }

    destroy() {
        this.settings.disconnect(this._applicationsChangedId);

        super.destroy();
    }
});

