const AsyncQueue = require('./AsyncQueue')
const {
    Events: { RATE_LIMIT },
} = require('../util/Constants');
const Util = require('../util/Util');

const DiscordAPIError = require('./DiscordAPIError');
const HTTPError = require('./HTTPError');
const parseResponse = async (res) => {
    if (res.headers["content-type"]?.includes("application/json")) {
        const json = res.json();
        return json;
    }
    return res.body.toString();
};

const getAPIOffset = (serverDate) => {
    return new Date(serverDate).getTime() - Date.now();
};

const calculateReset = (reset, serverDate) => {
    return new Date(Number(reset) * 1000).getTime() - getAPIOffset(serverDate);
};

module.exports = class RequestHandler {
    constructor(manager) {
        this.manager = manager;
        this.queue = new AsyncQueue();
        this.reset = -1;
        this.remaining = -1;
        this.limit = -1;
        this.retryAfter = -1;
    }

    async push(request) {
        await this.queue.wait();
        try {
            return await this.execute(request);
        } finally {
            this.queue.shift();
        }
    }

    get limited() {
        return (
            Boolean(this.manager.globalTimeout) ||
            (this.remaining <= 0 && Date.now() < this.reset)
        );
    }

    get _inactive() {
        return this.queue.remaining === 0 && !this.limited;
    }

    async execute(request) {
        // After calculations and requests have been done, pre-emptively stop further requests
        if (this.limited) {
            const timeout =
                this.reset + this.manager.client.options.restTimeOffset - Date.now();

            if (this.manager.client.listenerCount(RATE_LIMIT)) {
                // @ts-ignore
                this.manager.client.emit(RATE_LIMIT, {
                    timeout,
                    limit: this.limit,
                    method: request.method,
                    path: request.path,
                    route: request.route,
                });
            }

            if (this.manager.globalTimeout) {
                await this.manager.globalTimeout;
            } else {
                // Wait for the timeout to expire in order to avoid an actual 429
                await Util.delayFor(timeout);
            }
        }

        // Perform the request
        let res;
        try {
            res = await request.make();
        } catch (error) {
            this.checkLatency(request, res);
            // Retry the specified number of times for request abortions
            if (request.retries === this.manager.client.options.retryLimit) {
                throw new HTTPError(
                    error.message,
                    error.constructor.name,
                    error.status,
                    request.method,
                    request.path
                );
            }

            request.retries++;
            return this.execute(request);
        }

        this.checkLatency(request, res);

        if (res && res.headers) {
            const serverDate = res.headers.date;
            const limit = res.headers["x-ratelimit-limit"];
            const remaining = res.headers["x-ratelimit-remaining"];
            const reset = res.headers["x-ratelimit-reset"];
            const retryAfter = res.headers["retry-after"];

            this.limit = limit ? Number(limit) : Infinity;
            this.remaining = remaining ? Number(remaining) : 1;
            this.reset = reset ? calculateReset(reset, serverDate) : Date.now();
            this.retryAfter = retryAfter ? Number(retryAfter) : -1;

            // https://github.com/discordapp/discord-api-docs/issues/182
            if (request.route.includes("reactions")) {
                this.reset =
                    new Date(serverDate).getTime() - getAPIOffset(serverDate) + 250;
            }

            // Handle global ratelimit
            if (res.headers["x-ratelimit-global"]) {
                // Set the manager's global timeout as the promise for other requests to "wait"
                this.manager.globalTimeout = Util.delayFor(this.retryAfter);

                // Wait for the global timeout to resolve before continuing
                await this.manager.globalTimeout;

                // Clean up global timeout
                this.manager.globalTimeout = null;
            }
        }

        // Handle 2xx and 3xx responses
        if (res.statusCode >= 200 && res.statusCode < 400) {
            // Nothing wrong with the request, proceed with the next one
            return parseResponse(res);
        }

        // Handle 4xx responses
        if (res.statusCode >= 400 && res.statusCode < 500) {
            // Handle ratelimited requests
            if (res.statusCode === 429) {
                // A ratelimit was hit - this should never happen
                this.manager.client.emit("debug", `429 hit on route ${request.route}`);
                await Util.delayFor(this.retryAfter);
                return this.execute(request);
            }

            // Handle possible malformed requests
            let data;
            try {
                data = await parseResponse(res);
            } catch (err) {
                throw new HTTPError(
                    err.message,
                    err.constructor.name,
                    err.status,
                    request.method,
                    request.path
                );
            }

            if (
                request.route.includes("commands") &&
                res.statusCode == 404 &&
                request.client.options.http.api.includes("inv.wtf")
            )
                return;

            if (
                !(
                    request.route.endsWith("/messages/:id") &&
                    request.method == "delete" &&
                    res.statusCode == 404
                )
            )
                throw new DiscordAPIError(
                    request.path,
                    data,
                    request.method,
                    res.statusCode
                );
        }

        // Handle 5xx responses
        if (res.statusCode >= 500 && res.statusCode < 600) {
            // Retry the specified number of times for possible serverside issues
            if (request.retries === this.manager.client.options.retryLimit) {
                throw new HTTPError(
                    res.coreRes.statusMessage,
                    res.constructor.name,
                    res.statusCode,
                    request.method,
                    request.path
                );
            }

            request.retries++;
            return this.execute(request);
        }

        // Fallback in the rare case a status code outside the range 200..=599 is returned
        return null;
    }

    checkLatency(request, response) {
        const latency = request.client.restPing;
        const useHigher = !!(request.options.files && request.options.files.length);
        let type;
        if (useHigher ? latency > 10000 : latency > 5000) type = "high";
        else if (useHigher ? latency > 20000 : latency > 10000) type = "extreme";
        if (!type) return;
        const API =
            request.options.versioned === false
                ? request.client.options.http.api
                : `${request.client.options.http.api}/v${request.client.options.http.version}`;
        const url = API + request.path;
        request.client.emit(`${type == "high" ? "warn" : "error"}`,
            `[Rest] Encountered ${type} latency of ${latency}ms on ${request.method.toUpperCase()} ${request.path
            }`
        );
        if (process.env.NODE_ENV === "production" && latency > 10000 && request.client.sentry)
            request.client.sentry.captureEvent({
                message: `Encountered ${type} latency of ${latency}ms on ${request.method.toUpperCase()} ${request.path
                    }`,
                request: {
                    url,
                    method: request.method,
                    data: request.options?.data,
                    headers: request.options?.headers,
                },
                tags: {
                    reason: request.options?.reason,
                    status: response?.statusCode,
                },
                extra: response?.headers,
            });
    }
}
