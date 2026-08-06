# Clawbot Design System

## 0. Research Log

- Embedded references: shortlisted Vercel, Sentry, and ClickHouse for operational density; selected the Vercel reference plus the operational dashboard guidance because its restrained surfaces, compact type hierarchy, and visible focus treatment fit a webhook control plane without copying its brand expression.
- Lazyweb: ran 3 desktop queries (`webhook operations dashboard`, `api monitoring dashboard`, and `webhook integration operations console`) and viewed Pendo, Middleware, and Pendo Webhooks screens. The reusable grammar is a quiet top frame, one content limiter, dense metadata grouped inside restrained panels, and clear alternate actions when a primary path has no data.
- UI/UX database: the `webhook operations console neutral accessible` search recommends a neutral real-time operations pattern with semantic status colors, keyboard-first controls, and data density that remains scannable.
- Imagen drafts: skipped because no image-generation tool is available in this environment. This task ships a component showcase, not a product marketing surface.

## 1. Atmosphere & Identity

Clawbot is a sober operations desk for people responding to webhook traffic. The signature is cool mineral depth: graphite text, blue-steel surfaces, and a single clear blue action color make dense information feel structured rather than urgent. Status color is evidence, never decoration.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
| --- | --- | --- | --- | --- |
| Canvas | `--ui-surface-canvas` | `#F6F8FA` | Not in scope | Page background |
| Raised surface | `--ui-surface-raised` | `#FFFFFF` | Not in scope | Panels, form fields |
| Sunken surface | `--ui-surface-sunken` | `#EAF0F5` | Not in scope | Table headers, quiet groups |
| Strong text | `--ui-text-strong` | `#18212B` | Not in scope | Headings and body |
| Muted text | `--ui-text-muted` | `#536271` | Not in scope | Help text and metadata |
| Divider | `--ui-border` | `#CFD8E1` | Not in scope | Structural boundaries |
| Primary action | `--ui-color-primary` | `#185FA5` | Not in scope | Buttons, links, focus context |
| Success | `--ui-status-success` | `#1E7A46` | Not in scope | Completed or healthy state |
| Warning | `--ui-status-warning` | `#9B5A00` | Not in scope | Action needed state |
| Error | `--ui-status-error` | `#B42318` | Not in scope | Failed state |
| Info | `--ui-status-info` | `#185FA5` | Not in scope | Informational state |
| Focus | `--ui-focus` | `#185FA5` | Not in scope | Keyboard outline |

### Rules

- Every UI color is a semantic token. Components never introduce local color values.
- The primary color signals an available action. Status always includes readable text, not color alone.
- This task establishes the light operations theme. Any future dark theme must define a corresponding Ant Design algorithm and contrast-verified token set before it is exposed.

## 3. Typography

| Level | Token | Size | Weight | Line height | Usage |
| --- | --- | --- | --- | --- | --- |
| Page title | `--ui-type-page` | 32px | 600 | 1.25 | Showcase and route headings |
| Section title | `--ui-type-section` | 24px | 600 | 1.33 | Panel headings |
| Body | `--ui-type-body` | 16px | 400 | 1.5 | Default content and controls |
| Small | `--ui-type-small` | 14px | 400 | 1.43 | Help text and table metadata |
| Label | `--ui-type-label` | 12px | 500 | 1.33 | Technical labels and status metadata |

- Primary stack: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Mono stack: `ui-monospace, "SFMono-Regular", Consolas, monospace` for identifiers and timestamps only.
- Body text is never smaller than 14px. Numeric data may use tabular figures.

## 4. Spacing & Layout

| Token | Value | Usage |
| --- | --- | --- |
| `--ui-space-1` | 4px | Tight inline gap |
| `--ui-space-2` | 8px | Compact control group |
| `--ui-space-3` | 12px | Field internals |
| `--ui-space-4` | 16px | Standard panel and form rhythm |
| `--ui-space-6` | 24px | Panel padding and column gap |
| `--ui-space-8` | 32px | Section separation |
| `--ui-space-12` | 48px | Route separation |

- Content limiter: 1200px maximum inline size. Gutters are 16px at 375px, 24px at 768px, and 32px at 1280px.
- Responsive grids use the `ui-responsive-grid` contract: one stack at 375px, two columns at 768px, and three columns at 1280px where content permits.
- Primary content reflows without horizontal scrolling. Tables scroll only inside their labeled table region when required by columns.
- Shared CSS also exposes `--ui-content-limit: 1200px` and `--ui-radius-panel: 8px` for the content limiter and panel treatment.

## 5. Components

### `UiProvider`
- **Structure**: `AntdRegistry > ConfigProvider > children`.
- **States**: preserves Ant Design focus, disabled, and loading states.
- **Accessibility**: supplies a single theme boundary without changing DOM order.

### `PrimitivePanel`
- **Structure**: labelled `section` with heading and body.
- **Spacing**: `--ui-space-6` padding and `--ui-space-3` heading gap.
- **States**: default and responsive grid placement.
- **Accessibility**: heading supplies the section name; long content wraps.

### `StatusLabel`
- **Structure**: text-bearing Ant Design tag inside a `role="status"` live-neutral region.
- **Variants**: success, warning, error, info.
- **Accessibility**: the visible text and `aria-label` name the status without relying on color.

### `FormField`
- **Structure**: visible label, control, optional helper text, and inline error region.
- **States**: default, disabled, error, and help.
- **Accessibility**: labels associate to the control; error text uses `role="alert"`.

### `DataTable`, `EmptyState`, and `ErrorState`
- **Structure**: Ant Design table, empty, and alert primitives inside named panels.
- **States**: populated, empty, loading, and error.
- **Accessibility**: table headers remain semantic; empty and error states provide a textual next step.

## 6. Motion & Interaction

- Decorative motion is prohibited for this operations surface.
- Ant Design interaction feedback is limited to its built-in control states. Reduced motion receives the same static information and no custom transition is introduced.
- Every control keeps keyboard-visible focus through the focus token.

## 7. Depth & Surface

- Strategy: mixed tonal shift and one quiet structural border.
- Panels use `--ui-surface-raised` against `--ui-surface-canvas`, with a 1px `--ui-border` edge and 8px radius.
- Tables use `--ui-surface-sunken` headers to establish hierarchy. Heavy shadows, gradients, and glass effects are excluded.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA: 4.5:1 text contrast, visible keyboard focus, semantic headings, associated form labels, and status text independent of color.
- The showcase must be operable using keyboard tab order and must hold its information hierarchy at 375px, 768px, and 1280px.
- No emoji icons, decorative motion, placeholder-only labels, or icon-only controls are permitted in the primitive layer.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| React dev instrumentation is absent | Root tooling | Task 2 cannot alter root manifests or the Task 1-owned root layout. | Add the configured dev-only tools in a dedicated tooling task. |
