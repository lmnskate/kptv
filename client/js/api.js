/* KPTV API client: device identity + JSON helpers.
   The device id is the credential, same as the MSX id param.
   XHR instead of fetch: MSX web views on old TVs lack fetch.
   The id comes from the ?id= URL param (MSX substitutes its device id there)
   and falls back to a locally generated one. */

(function () {
    'use strict';

    var DEVICE_KEY = 'kptv.deviceId';

    function uuid() {
        if (window.crypto && crypto.randomUUID) {
            return crypto.randomUUID();
        }

        return 'dev-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    }

    function storageGet() {
        try {
            return localStorage.getItem(DEVICE_KEY);
        } catch (e) {
            return null;
        }
    }

    function storageSet(value) {
        try {
            localStorage.setItem(DEVICE_KEY, value);
        } catch (e) { /* storage unavailable (some TV web views) */ }
    }

    var deviceId = null;
    var fromUrl = null;
    try {
        var match = /[?&]id=([^&#]+)/.exec(window.location.search || '');
        if (match) {
            fromUrl = decodeURIComponent(match[1]);
        }
    } catch (e) { /* no location.search */ }

    if (fromUrl && fromUrl !== '{ID}') {
        // MSX substituted its real device id — adopt it
        deviceId = fromUrl;
        storageSet(deviceId);
    }
    if (!deviceId) {
        deviceId = storageGet();
    }
    if (!deviceId) {
        deviceId = uuid();
        storageSet(deviceId);
    }

    function api(path, options) {
        options = options || {};
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(options.method || 'GET', '/api/v1' + path, true);
            xhr.setRequestHeader('X-Device-Id', deviceId);
            if (options.body !== undefined) {
                xhr.setRequestHeader('Content-Type', 'application/json');
            }
            /* без таймаута зависший запрос на ТВ-сети никогда не завершится —
               экран остаётся на «Загрузка…» навсегда */
            xhr.timeout = 25000;
            xhr.ontimeout = function () {
                reject(new Error('Превышено время ожидания'));
            };
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) {
                    return;
                }
                var data = null;
                try {
                    data = JSON.parse(xhr.responseText);
                } catch (e) {
                    data = null;
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(data);
                    return;
                }
                var error = new Error(
                    (data && data.error && data.error.message) || xhr.statusText || 'Ошибка сети'
                );
                error.code = data && data.error && data.error.code;
                error.status = xhr.status;
                reject(error);
            };
            xhr.onerror = function () {
                reject(new Error('Ошибка сети'));
            };
            xhr.send(options.body !== undefined ? JSON.stringify(options.body) : null);
        });
    }

    window.KPTV = window.KPTV || {};
    window.KPTV.deviceId = deviceId;
    window.KPTV.api = api;
})();
