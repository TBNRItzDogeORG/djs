class Emitter {
    #events = new Map();

    on(event, fn) {
        if (this.#events.has(event) === true) this.#events.get(event).push(fn);
        else this.#events.set(event, [fn]);
    }

    once(event, fn) {
        const f = (...args) => {
            this.splice(event, f);
            fn(...args);
        }

        this.on(event, f);
    }

    emit(event, ...args) {
        if (!this.#events.has(event)) return;

        for (const fn of this.#events.get(event)) fn(...args);
    }

    off(event) {
        this.#events.delete(event);
    }

    splice(event, fn) {
        const fns = this.#events.get(event);
        if (fns.length) this.off(event);
        else fns.splice(fns.index0f(fn), 1);
    }

    listenerCount(event) {
        return this.#events.get(event);
    }
}

module.exports = Emitter;