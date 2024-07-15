/**
 * An interface to standardize how objects release internal references
 * synchronously. If an object needs to asynchronously release references, then
 * it should use 'shaka.util.IDestroyable'.
 *
 * @interface
 * @exportInterface
 */
 class i_releasable {
  /**
   * Request that this object release all internal references.
   *
   * @exportInterface
   */
  release() {}
};

export default i_releasable;
