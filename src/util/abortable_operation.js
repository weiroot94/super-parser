import public_promise from './public_promise.js';
import error from './error.js';

/**
 * A utility to wrap abortable operations.  Note that these are not cancelable.
 * Cancelation implies undoing what has been done so far, whereas aborting only
 * means that further work is stopped.
 *
 * @template T
 * @export
 */
class abortable_operation {
  /**
   * @param {!Promise.<T>} promise
   *   A Promise which represents the underlying operation.  It is resolved when
   *   the operation is complete, and rejected if the operation fails or is
   *   aborted.  Aborted operations should be rejected with a error
   *   object using the error code OPERATION_ABORTED.
   * @param {function():!Promise} onAbort
   *   Will be called by this object to abort the underlying operation.
   *   This is not cancelation, and will not necessarily result in any work
   *   being undone.  abort() should return a Promise which is resolved when the
   *   underlying operation has been aborted.  The returned Promise should never
   *   be rejected.
   */
   constructor(promise, onAbort) {
    /** @const {!Promise.<T>} */
    this.promise = promise;

    /** @private {function():!Promise} */
    this.onAbort_ = onAbort;

    /** @private {boolean} */
    this.aborted_ = false;
  }

  /**
   * @param error
   * @return An operation which has already
   *   failed with the error given by the caller.
   * @export
   */
   static failed(error) {
    return new abortable_operation(
        Promise.reject(error),
        () => Promise.resolve());
  }

  /**
   * @return An operation which has already
   *   failed with the error OPERATION_ABORTED.
   * @export
   */
  static aborted() {
    const p = Promise.reject(abortable_operation.abortError());
    // Silence uncaught rejection errors, which may otherwise occur any place
    // we don't explicitly handle aborted operations.
    p.catch(() => {});
    return new abortable_operation(p, () => Promise.resolve());
  }

  /** @return {!util.error} */
  static abortError() {
    return new error(
        error.Severity.CRITICAL,
        error.Category.PLAYER,
        error.Code.OPERATION_ABORTED);
  }

  /**
   * @param {U} value
   * @return {!abortable_operation.<U>} An operation which has already
   *   completed with the given value.
   * @template U
   * @export
   */
  static completed(value) {
    return new abortable_operation(
        Promise.resolve(value),
        () => Promise.resolve());
  }

  /**
   * @param {!Promise.<U>} promise
   * @return {!abortable_operation.<U>} An operation which cannot be
   *   aborted.  It will be completed when the given Promise is resolved, or
   *   will be failed when the given Promise is rejected.
   * @template U
   * @export
   */
  static notAbortable(promise) {
    return new abortable_operation(
        promise,
        // abort() here will return a Promise which is resolved when the input
        // promise either resolves or fails.
        () => promise.catch(() => {}));
  }

  /**
   * @override
   * @export
   */
  abort() {
    this.aborted_ = true;
    return this.onAbort_();
  }

  /**
   * @param {!Array.<!abortable_operation>} operations
   * @return {!abortable_operation} An operation which is resolved
   *   when all operations are successful and fails when any operation fails.
   *   For this operation, abort() aborts all given operations.
   * @export
   */
  static all(operations) {
    return new abortable_operation(
        Promise.all(operations.map((op) => op.promise)),
        () => Promise.all(operations.map((op) => op.abort())));
  }

  /**
   * @override
   * @export
   */
  finally(onFinal) {
    this.promise.then((value) => onFinal(true), (e) => onFinal(false));
    return this;
  }

  /**
   * @param {(undefined|
   *          function(T):U|
   *          function(T):!Promise.<U>|
   *          function(T):!util.abortable_operation.<U>)} onSuccess
   *   A callback to be invoked after this operation is complete, to chain to
   *   another operation.  The callback can return a plain value, a Promise to
   *   an asynchronous value, or another AbortableOperation.
   * @param {function(*)=} onError
   *   An optional callback to be invoked if this operation fails, to perform
   *   some cleanup or error handling.  Analogous to the second parameter of
   *   Promise.prototype.then.
   * @return {!util.abortable_operation.<U>} An operation which is resolved
   *   when this operation and the operation started by the callback are both
   *   complete.
   * @template U
   * @export
   */
  chain(onSuccess, onError) {
    const newPromise = new public_promise();
    const abortError = abortable_operation.abortError();

    // If called before "this" completes, just abort "this".
    let abort = () => {
      newPromise.reject(abortError);
      return this.abort();
    };

    const makeCallback = (isSuccess) => {
      return (value) => {
        if (this.aborted_ && isSuccess) {
          // If "this" is not abortable(), or if abort() is called after "this"
          // is complete but before the next stage in the chain begins, we
          // should stop right away.
          newPromise.reject(abortError);
          return;
        }

        const cb = isSuccess ? onSuccess : onError;
        if (!cb) {
          // No callback?  Pass it along.
          const next = isSuccess ? newPromise.resolve : newPromise.reject;
          next(value);
          return;
        }

        // Call the callback, interpret the return value, set the Promise state,
        // and get the next abort function.
        abort = abortable_operation.wrapChainCallback_(
            cb, value, newPromise);
      };
    };
    this.promise.then(makeCallback(true), makeCallback(false));

    return new abortable_operation(
        newPromise,
        // By creating a closure around abort(), we can update the value of
        // abort() at various stages.
        () => abort());
  }

  /**
   * @param {(function(T):U|
   *          function(T):!Promise.<U>|
   *          function(T):!abortable_operation.<U>|
   *          function(*))} callback
   *   A callback to be invoked with the given value.
   * @param {T} value
   * @param {!util.public_promise} newPromise The promise for the next
   *   stage in the chain.
   * @return {function():!Promise} The next abort() function for the chain.
   * @private
   * @template T, U
   */
  static wrapChainCallback_(callback, value, newPromise) {
    try {
      const ret = callback(value);

      if (ret && ret.promise && ret.abort) {
        // This is an abortable operation, with its own abort() method.
        // After this point, abort() should abort the operation from the
        // callback, and the new promise should be tied to the promise
        // from the callback's operation.
        newPromise.resolve(ret.promise);
        // This used to say "return ret.abort;", but it caused subtle issues by
        // unbinding part of the abort chain.  There is now a test to ensure
        // that we don't call abort with the wrong "this".
        return () => ret.abort();
      } else {
        // This is a Promise or a plain value, and this step cannot be aborted.
        newPromise.resolve(ret);
        // Abort is complete when the returned value/Promise is resolved or
        // fails, but never fails itself nor returns a value.
        return () => Promise.resolve(ret).then(() => {}, () => {});
      }
    } catch (exception) {
      // The callback threw an exception or error.  Reject the new Promise and
      // resolve any future abort call right away.
      newPromise.reject(exception);
      return () => Promise.resolve();
    }
  }
}

export default abortable_operation;