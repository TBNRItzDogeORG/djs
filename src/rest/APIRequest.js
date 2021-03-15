const FormData = require('@discordjs/form-data');
const { UserAgent } = require('../util/Constants');
const centra = require('@helperdiscord/centra');

module.exports = class APIRequest {
    constructor(
        rest,
        method,
        path,
        options
    ) {
        this.rest = rest;
        this.client = rest.client;
        this.method = method;
        this.route = options.route;
        this.options = options;
        this.retries = 0;

        let queryString = "";
        if (options.query) {
            const query = Object.entries(options.query)
                .filter(([, value]) => value !== null && typeof value !== "undefined")
                .flatMap(([key, value]) =>
                    Array.isArray(value) ? value.map((v) => [key, v]) : [[key, value]]
                );
            queryString = new URLSearchParams(query).toString();
        }
        this.path = `${path}${queryString && `?${queryString}`}`;
    }

    make() {
        if (this.options.debug)
            this.client.emit(`warn`,
                `[Rest] Creating request for ${this.method.toUpperCase()} ${this.path}`
            );
        const API =
            this.options.versioned === false
                ? this.client.options.http.api
                : `${this.client.options.http.api}/v${this.client.options.http.version}`;
        const url = API + this.path;
        let headers = {};

        if (this.options.auth !== false)
            headers.Authorization = this.rest.getAuth();
        if (this.options.reason)
            headers["X-Audit-Log-Reason"] = encodeURIComponent(this.options.reason);
        headers["User-Agent"] = UserAgent;
        if (this.options.headers)
            headers = Object.assign(headers, this.options.headers);

        let body;
        if (this.options.files && this.options.files.length) {
            body = new FormData();
            for (const file of this.options.files)
                if (file && file.file) body.append(file.name, file.file, file.name);
            if (typeof this.options.data !== "undefined")
                body.append("payload_json", JSON.stringify(this.options.data));
            headers = Object.assign(headers, body.getHeaders());
        } else if (this.options.data != null) body = this.options.data;

        const request = centra(url, this.method)
            .body(
                body instanceof FormData ? body.getBuffer() : body,
                body instanceof FormData ? "buffer" : "json"
            )
            .timeout(this.client.options.restRequestTimeout)
            .header(headers);
        if (this.options.debug)
            this.client.emit(`warn`,
                `[Rest] Sending request to ${this.method.toUpperCase()} ${this.path}`
            );
        const start = +new Date();
        return request.send().finally(() => {
            this.client.restPing = +new Date() - start;
            if (this.options.debug)
                this.client.emit(`warn`,
                    `[Rest] Finished request to ${this.method.toUpperCase()} ${this.path
                    } in ${this.client.restPing}ms`
                );
        });
    }
}