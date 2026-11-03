import { useTheme } from 'twenty-ui/theme-constants';

/** Scoped to the app: never change the host workspace's controls. */
export const SurfaceStyles = () => {
  const theme = useTheme();
  return <style>{`
.wa-surface { min-width: 0; line-height: 1.4; }
.wa-surface :is(button, a, input, textarea, select, [tabindex]):focus-visible {
  outline: 2px solid ${theme.color.blue};
  outline-offset: 2px;
}
.wa-surface button:disabled { cursor: not-allowed; opacity: .6; }
.wa-surface :is(input, textarea, select) { max-width: 100%; }
.wa-composer { container-type: inline-size; container-name: wa-composer; }
.wa-composer-controls {
  display: flex; flex-direction: column; min-width: 0;
  border: 1px solid ${theme.border.color.medium}; border-radius: ${theme.border.radius.md};
  background: ${theme.background.secondary};
  transition: border-color 120ms ease;
}
.wa-composer-controls:focus-within { border-color: ${theme.color.blue}; }
.wa-composer-input {
  display: block; box-sizing: border-box; width: 100%; min-width: 0;
  min-height: 76px; max-height: min(144px, calc(26dvh / var(--t-zoom, 1)));
  field-sizing: content; resize: none; overflow-y: auto;
  border: 0; border-radius: ${theme.border.radius.md}; outline: none;
  background: transparent; color: ${theme.font.color.primary};
  font-family: ${theme.font.family}; font-size: ${theme.font.size.md}; line-height: 1.5;
  padding: 12px 12px 4px;
}
.wa-surface .wa-composer-input:focus-visible { outline: none; }
.wa-composer-toolbar { display: flex; align-items: center; gap: 12px; padding: 4px 8px 8px; min-width: 0; }
.wa-composer-tools { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.wa-composer-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto; }
.wa-composer-action { position: relative; display: inline-flex; flex: 0 0 auto; }
.wa-composer-icon {
  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  width: 36px; height: 36px; padding: 0; border: 0; border-radius: ${theme.border.radius.sm};
  background: transparent; color: ${theme.font.color.secondary}; cursor: pointer;
  transition: background 120ms ease;
}
.wa-composer-icon:not(:disabled):hover,
.wa-composer-icon[aria-expanded="true"] { background: ${theme.background.transparent.light}; color: ${theme.font.color.primary}; }
.wa-composer-icon[data-primary="true"] { background: ${theme.color.blue}; color: #fff; }
.wa-composer-icon[data-primary="true"]:not(:disabled):hover { background: ${theme.color.blue}; color: #fff; filter: brightness(1.08); }
.wa-composer-icon[data-primary="true"]:disabled { background: ${theme.background.transparent.light}; color: ${theme.font.color.secondary}; }
.wa-composer-hint { flex: 1 1 auto; min-width: 0; font-size: ${theme.font.size.xs}; color: ${theme.font.color.secondary}; }
.wa-composer-count { font-size: ${theme.font.size.xs}; color: ${theme.font.color.secondary}; font-variant-numeric: tabular-nums; }
.wa-composer-tooltip {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 4;
  padding: 6px 8px; border: 1px solid ${theme.border.color.medium}; border-radius: ${theme.border.radius.sm};
  background: ${theme.background.primary}; color: ${theme.font.color.primary}; box-shadow: ${theme.boxShadow.strong};
  font-size: ${theme.font.size.sm}; white-space: nowrap; pointer-events: none;
  visibility: hidden; opacity: 0; transition: opacity 120ms ease;
}
.wa-composer-tooltip[data-align="end"] { left: auto; right: 0; }
.wa-composer-action:not([data-tooltip-dismissed="true"]):hover .wa-composer-tooltip,
.wa-composer-action:not([data-tooltip-dismissed="true"]):focus-within .wa-composer-tooltip { visibility: visible; opacity: 1; }
.wa-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@container wa-composer (max-width: 520px) {
  .wa-composer-hint { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) {
  .wa-surface *, .wa-surface *::before, .wa-surface *::after { transition: none !important; }
}
`}</style>;
};
