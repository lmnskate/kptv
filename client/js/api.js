/* KPTV API client: device identity + JSON helpers.
   XHR instead of fetch: MSX web views on old TVs lack fetch. */

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
        } catch (e) {}
    }

    var deviceId = null;
    var fromUrl = null;
    try {
        var match = /[?&]id=([^&#]+)/.exec(window.location.search || '');
        if (match) {
            fromUrl = decodeURIComponent(match[1]);
        }
    } catch (e) {}

    if (fromUrl && fromUrl !== '{ID}') {
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
        return apiAttempt(path, options || {}, 0);
    }

    function apiAttempt(path, options, attempt) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            var url = '/api/v1' + path + (path.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
            var isGet = !options.method || options.method === 'GET';
            xhr.open(options.method || 'GET', url, true);
            xhr.setRequestHeader('X-Device-Id', deviceId);
            if (options.body !== undefined) {
                xhr.setRequestHeader('Content-Type', 'application/json');
            }
            xhr.timeout = options.timeout || 25000;
            xhr.ontimeout = function () {
                if (isGet && attempt === 0) {
                    resolve(apiAttempt(path, options, 1));
                    return;
                }
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
                if (isGet && attempt === 0) {
                    resolve(apiAttempt(path, options, 1));
                    return;
                }
                reject(new Error('Ошибка сети'));
            };
            xhr.send(options.body !== undefined ? JSON.stringify(options.body) : null);
        });
    }

    window.KPTV = window.KPTV || {};
    window.KPTV.deviceId = deviceId;
    window.KPTV.api = api;
})();
