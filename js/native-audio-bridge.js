// native-audio-bridge.js
// Drop-in replacement for direct <audio> control.
// Calls the native Luna service methods.

const NativeAudioBridge = {
    _service: "luna://com.leoaj2005.octave.service",

    _request(method, params, onSuccess, onFailure) {
        if (typeof webOS !== 'undefined' && webOS.service) {
            webOS.service.request(this._service, {
                method: method,
                parameters: params || {},
                onSuccess: onSuccess || (() => {}),
                onFailure: onFailure || ((e) => console.error('[Octave]', e))
            });
        } else {
            console.warn('[Octave] webOS service unavailable (dev environment?)');
        }
    },

    play(url) {
        this._request('play', { uri: url }, () => {
            document.getElementById('btn-play').textContent = '⏸';
        });
    },

    pause() {
        this._request('pause', null, () => {
            document.getElementById('btn-play').textContent = '▶';
        });
    },

    resume() {
        this._request('resume', null, () => {
            document.getElementById('btn-play').textContent = '⏸';
        });
    },

    stop() {
        this._request('stop', null, () => {
            document.getElementById('btn-play').textContent = '▶';
        });
    },

    seek(seconds) {
        this._request('seek', { position: Number(seconds) });
    },

    getPosition(callback) {
        this._request('getPosition', null, (res) => {
            if (callback) callback(res);
        });
    }
};