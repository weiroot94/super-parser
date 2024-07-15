import delayed_tick from './delayed_tick.js';

/**
 * A timer allows a single function to be executed at a later time or
 * at regular intervals.
 */
class timer {
  constructor(onTick) {
    this.onTick_ = onTick;
    this.ticker_ = null;
  }

  tickNow() {
    this.stop();
    this.onTick_();

    return this;
  }

  tickAfter(seconds) {
    this.stop();

    this.ticker_ = new delayed_tick(() => {
      this.onTick_();
    }).tickAfter(seconds);

    return this;
  }

  tickEvery(seconds) {
    this.stop();

    this.ticker_ = new delayed_tick(() => {
      this.ticker_.tickAfter(seconds);
      this.onTick_();
    }).tickAfter(seconds);

    return this;
  }

  stop() {
    if (this.ticker_) {
      this.ticker_.stop();
      this.ticker_ = null;
    }
  }
}

export default timer;