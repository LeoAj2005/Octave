const SecureCryptoSandbox = {
    _aesKeyStoreMemoryTarget: null,

    init: async function() {
        this.verifyBackdropFilterSupport();
        this.monitorCSPViolations();
        try {
            if (!window.crypto || !window.crypto.subtle) throw new Error("SubtleCrypto API unavailable.");
            await this.generateHardwareScopedEntropyKey();
        } catch (e) {
            console.warn("Secure context storage disabled.", e.message);
            this._aesKeyStoreMemoryTarget = null;
        }
    },

    verifyBackdropFilterSupport() {
        try {
            const supports = (window.CSS?.supports?.('(-webkit-backdrop-filter: blur(1px))') || window.CSS?.supports?.('(backdrop-filter: blur(1px))'));
            if (supports) document.body.classList.add('backdrop-supported');
        } catch(e) { console.warn(e); }
    },

    monitorCSPViolations() {
        document.addEventListener("securitypolicyviolation", (event) => {
            console.error(`CSP Violation: ${event.violatedDirective}`);
        });
    },

    sanitizeOutputText(inputString) {
        if (!inputString) return "";
        const map = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
        return inputString.replace(/[&<>"']/g, (ch) => map[ch]);
    },

    async generateHardwareScopedEntropyKey() {
        const salt = new Uint8Array([75,111,105,118,101,114,115,101,95,84,86,95,83,97,108,116]);
        const seed = new TextEncoder().encode("ArchiveTune_Isolation_Context_Seed");
        const baseKey = await crypto.subtle.importKey("raw", seed, { name: "PBKDF2" }, false, ["deriveKey"]);
        this._aesKeyStoreMemoryTarget = await crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 80000, hash: "SHA-256" },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    },

    async writeSecureValue(storageKey, plainTextPayload) {
        try {
            if (!this._aesKeyStoreMemoryTarget) {
                localStorage.setItem(storageKey, plainTextPayload);
                return;
            }
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(plainTextPayload);
            const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this._aesKeyStoreMemoryTarget, encoded);
            const payload = {
                iv: btoa(String.fromCharCode(...iv)),
                cipher: btoa(String.fromCharCode(...new Uint8Array(cipher)))
            };
            localStorage.setItem(storageKey, JSON.stringify(payload));
        } catch(e) { console.error(e); }
    },

    async readSecureValue(storageKey) {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        if (!this._aesKeyStoreMemoryTarget) return raw;
        try {
            const obj = JSON.parse(raw);
            const iv = new Uint8Array(atob(obj.iv).split("").map(c => c.charCodeAt(0)));
            const cipher = new Uint8Array(atob(obj.cipher).split("").map(c => c.charCodeAt(0)));
            const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this._aesKeyStoreMemoryTarget, cipher);
            return new TextDecoder().decode(decrypted);
        } catch(e) { console.warn(e); return null; }
    },

    flushIdentityCache() {
        localStorage.clear();
        sessionStorage.clear();
        window.location.reload();
    }
};

window.addEventListener("DOMContentLoaded", () => SecureCryptoSandbox.init());