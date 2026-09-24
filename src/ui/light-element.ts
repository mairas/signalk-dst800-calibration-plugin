import { LitElement } from 'lit'

/**
 * A component rendered into the page's own DOM rather than a shadow root.
 *
 * The console borrows the Signal K admin UI's Bootstrap stylesheet, which
 * `index.html` adds to the document head. A stylesheet in the head does not
 * reach into a shadow root, so a shadow-DOM component would render unstyled.
 */
export class LightElement extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this
  }
}
