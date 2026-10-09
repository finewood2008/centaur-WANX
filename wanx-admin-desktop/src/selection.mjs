/** Read responses can update a form only while both its selection and request are current. */
export class SelectionGuard {
  #key;
  #revision = 0;
  select(key) {
    if (key !== this.#key) {
      this.#key = key;
      this.#revision++;
    }
  }
  begin(key) {
    this.select(key);
    const revision = ++this.#revision;
    return () => this.#key === key && this.#revision === revision;
  }
  invalidate() {
    this.#revision++;
  }
}
