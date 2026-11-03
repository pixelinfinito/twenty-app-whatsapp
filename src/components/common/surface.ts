/**
 * How tall a WhatsApp surface is allowed to be.
 *
 * **This is not a style preference, it is a workaround, and it is worth saying
 * why.** A widget in a Twenty page layout is sized by its content: the tab pane
 * is a grid whose row is computed from what we render (`grid-template-rows`
 * came back as `1932px` for a chat with eleven messages in a 724px pane). So
 * `height: 100%` resolves against an `auto` parent and means nothing — which is
 * how a chat with real history ended up 1 900px tall, scrolling the record page
 * instead of itself, with the composer somewhere below the fold. CLAUDE.md
 * names that failure outright.
 *
 * The obvious fix — measure the pane and size to it — is unavailable: probe P-6
 * found `getBoundingClientRect()` returns 0×0 in this sandbox and there is no
 * `ResizeObserver`. So the bound has to be something CSS can resolve without
 * being told, and the viewport is the only such thing.
 *
 * `height: 100%` is kept alongside it: where a parent *is* bounded the
 * percentage wins and the surface fills its pane exactly; where it is not, the
 * cap bites and the surface scrolls internally. Neither case grows the page.
 */
export const SURFACE_MAX_HEIGHT = 'calc(72dvh / var(--t-zoom, 1))';

/**
 * The same workaround for a surface that owns a **whole page**.
 *
 * The inbox is not a widget beside a record's fields — it is the page. Giving
 * it the embedded cap left roughly a quarter of the viewport empty below the
 * composer: dead grey space a rep cannot use, under the one control they use
 * most. 72vh is the right answer for something sharing a record page and the
 * wrong one for something that *is* the page.
 *
 * Reserve 96 CSS pixels for the host title and notification banner. A rem
 * subtraction used the host's 13px root font and reserved only 52px, placing
 * Send 36px below the viewport. Use CSS pixels and the dynamic viewport so
 * the whole composer stays visible even on short screens. Divide by Twenty’s
 * zoom token: its mobile and user scaling otherwise enlarges the viewport
 * height a second time and pushes the footer below the screen.
 */
export const SURFACE_PAGE_HEIGHT = 'calc(100dvh / var(--t-zoom, 1) - 96px)';

/** Below this a chat is a viewport, not a conversation. */
export const SURFACE_MIN_HEIGHT = 'min(420px, 60dvh / var(--t-zoom, 1))';
