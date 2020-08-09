'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const AggregateMenu = Main.panel.statusArea.aggregateMenu;

// Bootstrap
const Extension = imports.misc.extensionUtils.getCurrentExtension();
Extension.imports._gsconnect;

// eslint-disable-next-line no-redeclare
const _ = Extension._;
const Clipboard = Extension.imports.shell.clipboard;
const Device = Extension.imports.shell.device;
const Keybindings = Extension.imports.shell.keybindings;
const Notification = Extension.imports.shell.notification;
const Remote = Extension.imports.utils.remote;


/**
 * A function to fetch a GIcon with fallback support for getting unthemed icons
 * from our GResource
 */
Extension.getIcon = function(name) {
    if (Extension.getIcon._extension === undefined) {
        // Setup the desktop icons
        let settings = imports.gi.St.Settings.get();
        Extension.getIcon._desktop = new Gtk.IconTheme();
        Extension.getIcon._desktop.set_custom_theme(settings.gtk_icon_theme);
        settings.connect('notify::gtk-icon-theme', (settings) => {
            Extension.getIcon._desktop.set_custom_theme(settings.gtk_icon_theme);
        });

        // Preload our fallbacks
        let basePath = 'resource://org/gnome/Shell/Extensions/GSConnect/icons/';
        let iconNames = [
            'org.gnome.Shell.Extensions.GSConnect',
            'org.gnome.Shell.Extensions.GSConnect-symbolic',
            'computer-symbolic',
            'laptop-symbolic',
            'smartphone-symbolic',
            'tablet-symbolic',
            'tv-symbolic',
            'phonelink-ring-symbolic',
            'sms-symbolic'
        ];

        Extension.getIcon._extension = {};

        for (let iconName of iconNames) {
            Extension.getIcon._extension[iconName] = new Gio.FileIcon({
                file: Gio.File.new_for_uri(`${basePath}${iconName}.svg`)
            });
        }
    }

    // Check the desktop icon theme
    if (Extension.getIcon._desktop.has_icon(name))
        return new Gio.ThemedIcon({name: name});

    // Check our GResource
    if (Extension.getIcon._extension[name] !== undefined)
        return Extension.getIcon._extension[name];

    // Fallback to hoping it's in the theme somewhere
    return new Gio.ThemedIcon({name: name});
};


/**
 * A System Indicator used as the hub for spawning device indicators and
 * indicating that the extension is active when there are none.
 */
const ServiceIndicator = GObject.registerClass({
    GTypeName: 'GSConnectServiceIndicator'
}, class ServiceIndicator extends PanelMenu.SystemIndicator {

    _init() {
        super._init();

        this._menus = {};

        this._keybindings = new Keybindings.Manager();

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                null
            ),
            path: '/org/gnome/shell/extensions/gsconnect/'
        });

        this._enabledId = this.settings.connect(
            'changed::enabled',
            this._onEnabledChanged.bind(this)
        );

        this._panelModeId = this.settings.connect(
            'changed::show-indicators',
            this._sync.bind(this)
        );

        // Service Proxy
        this.service = new Remote.Service();

        this._deviceAddedId = this.service.connect(
            'device-added',
            this._onDeviceAdded.bind(this)
        );

        this._deviceRemovedId = this.service.connect(
            'device-removed',
            this._onDeviceRemoved.bind(this)
        );

        this._serviceChangedId = this.service.connect(
            'notify::active',
            this._onServiceChanged.bind(this)
        );

        // Service Indicator
        this._indicator = this._addIndicator();
        this._indicator.gicon = Extension.getIcon(
            'org.gnome.Shell.Extensions.GSConnect-symbolic'
        );
        this._indicator.visible = false;

        AggregateMenu._indicators.insert_child_at_index(this, 0);
        AggregateMenu._gsconnect = this;

        // Service Menu
        this._item = new PopupMenu.PopupSubMenuMenuItem(_('Mobile Devices'), true);
        this._item.icon.gicon = this._indicator.gicon;
        this._item.label.clutter_text.x_expand = true;
        this.menu.addMenuItem(this._item);

        AggregateMenu.menu.addMenuItem(this.menu, 4);

        // Service Menu -> Devices Section
        this.deviceSection = new PopupMenu.PopupMenuSection();
        this.deviceSection.actor.add_style_class_name('gsconnect-device-section');
        this.settings.bind(
            'show-indicators',
            this.deviceSection.actor,
            'visible',
            Gio.SettingsBindFlags.INVERT_BOOLEAN
        );
        this._item.menu.addMenuItem(this.deviceSection);

        // Service Menu -> Separator
        this._item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Service Menu -> "Turn On/Off"
        this._enableItem = this._item.menu.addAction(
            _('Turn On'),
            this._enable.bind(this)
        );

        // Service Menu -> "Mobile Settings"
        this._item.menu.addAction(_('Mobile Settings'), this._preferences);

        // Prime the service
        this._initService();
    }

    async _initService() {
        try {
            if (this.settings.get_boolean('enabled'))
                await this.service.start();
            else
                await this.service.reload();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _enable() {
        try {
            let enabled = this.settings.get_boolean('enabled');

            // If the service state matches the enabled setting, we should
            // toggle the service by toggling the setting
            if (this.service.active === enabled)
                this.settings.set_boolean('enabled', !enabled);

            // Otherwise, we should change the service to match the setting
            else if (this.service.active)
                this.service.stop();
            else
                this.service.start();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _preferences() {
        Gio.Subprocess.new([`${Extension.path}/gsconnect-preferences`], 0);
    }

    _sync() {
        let available = this.service.devices.filter(device => {
            return (device.connected && device.paired);
        });
        let panelMode = this.settings.get_boolean('show-indicators');

        // Hide status indicator if in Panel mode or no devices are available
        this._indicator.visible = (!panelMode && available.length);

        // Show device indicators in Panel mode if available
        for (let device of this.service.devices) {
            let isAvailable = available.includes(device);
            let indicator = Main.panel.statusArea[device.g_object_path];

            indicator.visible = panelMode && isAvailable;

            let menu = this._menus[device.g_object_path];
            menu.actor.visible = !panelMode && isAvailable;
            menu._title.actor.visible = !panelMode && isAvailable;
        }

        // One connected device in User Menu mode
        if (!panelMode && available.length === 1) {
            let device = available[0];

            // Hide the menu title and move it to the submenu item
            this._menus[device.g_object_path]._title.actor.visible = false;
            this._item.label.text = device.name;

            // Destroy any other device's battery
            if (this._item._battery && this._item._battery.device !== device) {
                this._item._battery.destroy();
                this._item._battery = null;
            }

            // Add the battery to the submenu item
            if (!this._item._battery) {
                this._item._battery = new Device.Battery({
                    device: device,
                    opacity: 128
                });
                this._item.actor.insert_child_below(
                    this._item._battery,
                    this._item._triangleBin
                );
            }
        } else {
            if (available.length > 1) {
                // TRANSLATORS: %d is the number of devices connected
                this._item.label.text = Extension.ngettext(
                    '%d Connected',
                    '%d Connected',
                    available.length
                ).format(available.length);
            } else {
                this._item.label.text = _('Mobile Devices');
            }

            // Destroy any battery in the submenu item
            if (this._item._battery) {
                this._item._battery.destroy();
                this._item._battery = null;
            }
        }
    }

    _onDeviceChanged(device, changed, invalidated) {
        try {
            let properties = changed.deepUnpack();

            if (properties.hasOwnProperty('Connected') ||
                properties.hasOwnProperty('Paired')) {
                this._sync();
            }
        } catch (e) {
            logError(e, 'GSConnect' );
        }
    }

    _onDeviceAdded(service, device) {
        try {
            // Device Indicator
            let indicator = new Device.Indicator({device: device});
            Main.panel.addToStatusArea(device.g_object_path, indicator);

            // Device Menu
            let menu = new Device.Menu({
                device: device,
                menu_type: 'list'
            });
            this._menus[device.g_object_path] = menu;
            this.deviceSection.addMenuItem(menu);

            // Keyboard Shortcuts
            device.__keybindingsChangedId = device.settings.connect(
                'changed::keybindings',
                this._onDeviceKeybindingsChanged.bind(this, device)
            );
            this._onDeviceKeybindingsChanged(device);

            // Watch the for status changes
            device.__deviceChangedId = device.connect(
                'g-properties-changed',
                this._onDeviceChanged.bind(this)
            );

            this._sync();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _onDeviceRemoved(service, device, sync = true) {
        try {
            // Stop watching for status changes
            if (device.__deviceChangedId)
                device.disconnect(device.__deviceChangedId);

            // Release keybindings
            if (device.__keybindingsChangedId) {
                device.settings.disconnect(device.__keybindingsChangedId);
                device._keybindings.map(id => this._keybindings.remove(id));
            }

            // Destroy the indicator
            Main.panel.statusArea[device.g_object_path].destroy();

            // Destroy the menu
            this._menus[device.g_object_path].destroy();
            delete this._menus[device.g_object_path];

            if (sync)
                this._sync();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    _onDeviceKeybindingsChanged(device) {
        try {
            // Reset any existing keybindings
            if (device.hasOwnProperty('_keybindings'))
                device._keybindings.map(id => this._keybindings.remove(id));

            device._keybindings = [];

            // Get the keybindings
            let keybindings = device.settings.get_value('keybindings').deepUnpack();

            // Apply the keybindings
            for (let [action, accelerator] of Object.entries(keybindings)) {
                let [, name, parameter] = Gio.Action.parse_detailed_name(action);

                let actionId = this._keybindings.add(
                    accelerator,
                    () => device.action_group.activate_action(name, parameter)
                );

                if (actionId !== 0)
                    device._keybindings.push(actionId);
            }
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    async _onEnabledChanged(settings, key) {
        try {
            if (this.settings.get_boolean('enabled'))
                await this.service.start();
            else
                await this.service.stop();
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    async _onServiceChanged(service, pspec) {
        try {
            if (this.service.active) {
                // TRANSLATORS: A menu option to deactivate the extension
                this._enableItem.label.text = _('Turn Off');
            } else {
                // TRANSLATORS: A menu option to activate the extension
                this._enableItem.label.text = _('Turn On');

                // If it's enabled, we should try to restart now
                if (this.settings.get_boolean('enabled'))
                    await this.service.start();
            }
        } catch (e) {
            logError(e, 'GSConnect');
        }
    }

    destroy() {
        // Unhook from Remote.Service
        if (this.service) {
            this.service.disconnect(this._serviceChangedId);
            this.service.disconnect(this._deviceAddedId);
            this.service.disconnect(this._deviceRemovedId);

            for (let device of this.service.devices)
                this._onDeviceRemoved(this.service, device, false);

            this.service.destroy();
        }

        // Disconnect any keybindings
        this._keybindings.destroy();

        // Disconnect from any GSettings changes
        this.settings.disconnect(this._enabledId);
        this.settings.disconnect(this._panelModeId);
        this.settings.run_dispose();

        // Destroy the PanelMenu.SystemIndicator actors
        this._item.destroy();
        this.menu.destroy();

        delete AggregateMenu._gsconnect;
        super.destroy();
    }
});


var serviceIndicator = null;


function init() {
    // If installed as a user extension, this will install the Desktop entry,
    // DBus and systemd service files necessary for DBus activation and
    // GNotifications. Since there's no uninit()/uninstall() hook for extensions
    // and they're only used *by* GSConnect, they should be okay to leave.
    gsconnect.installService();

    // These modify the notification source for GSConnect's GNotifications and
    // need to be active even when the extension is disabled (eg. lock screen).
    // Since they *only* affect notifications from GSConnect, it should be okay
    // to leave them applied.
    Notification.patchGSConnectNotificationSource();
    Notification.patchGtkNotificationDaemon();

    // This watches for the service to start and exports a custom clipboard
    // portal for use on Wayland
    Clipboard.watchService();
}


function enable() {
    serviceIndicator = new ServiceIndicator();
    Notification.patchGtkNotificationSources();
}


function disable() {
    serviceIndicator.destroy();
    serviceIndicator = null;
    Notification.unpatchGtkNotificationSources();
}
