import assert from 'assert';

class lazy {
  constructor(gen) {
    this.gen_ = gen;
    this.value_ = undefined;
  }

  value() {
    if (this.value_ == undefined) {
      // Compiler complains about unknown fields without this cast
      this.value_ = this.gen_();

      /* Unable to create lazy value */
      assert(this.value_ != undefined);
    }
    return this.value_;
  }

  /** Resets the value fo the lazy function, so it has to be remade. */
  reset() {
    this.value_ = undefined;
  }
}

export default lazy;