# Agent-First Workspace Design System

This file is the visual and interaction contract for the R4 React/Vite web application. It is intentionally limited to login, Projects, Space administration, Work list/board/peek, Work metadata and relations, comments, Saved Views, lexical search, and import/export. The application renders Human Query and command DTOs as returned by the server; it does not reconstruct authorization, filtering, search, counts, ordering, or domain invariants in the browser.

## 0. Research Log

- **Product baseline:** [`docs/r4-delivery-contract.md`](docs/r4-delivery-contract.md), [`docs/roadmap.md`](docs/roadmap.md), and [`docs/product-and-domain.md`](docs/product-and-domain.md). These sources define the R4 boundary, Workspace/Space/Project/Work relationships, revision conflicts, server-authoritative queries, security boundary, and required human surfaces.
- **Embedded references:** shortlisted [Linear](https://linear.app), [Notion](https://www.notion.so), and [Airtable](https://www.airtable.com) from the local frontend reference index. Picked the local `minimalist-skill.md` Layer A and `linear.app.md` Layer B in full because a precise project-management hierarchy, compact controls, and restrained chroma fit the operational brief. Adapted decisions: one scarce accent, strong sidebar/list/detail hierarchy, compact metadata, visible selection, and low-radius controls. Rejected decisions: Linear's dark-first marketing canvas, Inter, ultra-faint contrast, and icon-only primary actions.
- **Lazyweb:** ran 3 desktop queries on 2026-10-11: `project management list board sidebar`, `issue detail drawer comments metadata`, and `saved views filters command palette`. Viewed 6 downloaded screens, not only search metadata: [ClickUp](https://clickup.com) board (`screens:2506f791d73b63312298814f`), ClickUp list (`screens:5452b3091ee426ffecf01a1b`), [Jira](https://www.atlassian.com/software/jira) issue master-detail (`screens:2ff70c92321a4395afd08b1c`), [Linear](https://linear.app) triage detail (`screens:c6165f54b1411773251ff3c3`), [Contractbook](https://contractbook.com) filtered-table/save-view (`screens:898cde34f138fdf2d2780886`), and [Cycle](https://www.cycle.app) view-settings (`screens:70f265955b17e4d1afee9aae`). Transferable grammar: a stable sidebar and page header, one compact contextual toolbar, aligned table metadata, independently scrolling board columns, selected-row detail without route loss, visible filter tokens, and prefilled focused configuration dialogs. Avoided their stacked navigation, crowded toolbars, tiny low-contrast metadata, duplicated create actions, and ambiguous adjacent save actions. Source service: [Lazyweb](https://www.lazyweb.com); screenshots were temporary research inputs and are not repository assets.
- **Imagen concept drafts:** skipped. No image-generation tool is available in the parent toolset, so no draft or reference-fidelity claim is made.
- **Designpowers:** loaded the frontend integration contract and Lane C review guidance. This document includes inclusive personas, adaptive constraints, debt language, and a future evidence handoff without claiming review of an unbuilt surface.
- **Primitive Showcase Gate:** pending by design. The implementation worker must build and visually verify the Section 5 primitive showcase at 375, 768, and 1280 px before composing product screens. No browser or visual-QA pass is claimed by this document-only task.

## 1. Atmosphere & Identity

### Direction

**A calm working ledger.** White and warm-neutral planes keep long operational sessions quiet; cool ink, exact dividers, and a single mineral-blue accent make hierarchy unambiguous. The signature moment is the **context seam**: selection in a table or board opens a peek surface from the right while the originating query, scroll position, filters, and selection remain visibly anchored behind it.

The interface should feel accountable, quick, and durable rather than decorative. Density is controlled, not sparse: structured server data is easy to compare, while descriptions and comments retain comfortable reading measure. There are no gradients, glass effects, oversized marketing type, decorative illustration, or chromatic UI chrome.

### Product principles

1. **Context before chrome:** Workspace, Space, Project, query, and selected Work Item remain legible during every action.
2. **Server truth is visible:** counts, result membership, board columns, search matches, permissions, warnings, revisions, and conflicts come from server DTOs. The UI does not “fix” or infer them.
3. **Structure before color:** alignment, typography, spacing, and separators carry hierarchy. Accent and semantic colors carry interaction or status only.
4. **Fast paths stay named:** frequent actions may include shortcuts, but visible labels remain. Icons from Phosphor Bold/Regular or Radix supplement text; no emoji or unlabeled custom glyphs.
5. **Edits are reversible and revision-aware:** optimistic feedback is local and restrained. A conflict restores server state for the affected field, retains unsent user text, and offers Reload or Cancel/Reapply where the command contract permits.
6. **Permissions never leak:** unavailable private or restricted entities do not appear in counts, filters, search, exports, or navigation. By-ID denial uses the same absence treatment as not-found.

### Content jobs and ordering

This is an app shell, not a marketing page. Content is ordered by the operator's decision path:

| Job | Content block | Outcome |
|---|---|---|
| Navigate | Workspace identity, primary sections, Spaces, Saved Views | Establish location without losing the active query |
| Orient | Breadcrumb, page title, result/selection context, revision/status | Answer “where am I and what am I changing?” |
| Control | Tabs, list/board toggle, search, filters, sort, primary create action | Change only the server query or start an authorized command |
| Compare | Project cards, Work table, board columns/cards, search results | Scan real structured data consistently |
| Inspect | Peek drawer with metadata, relations, comments, history affordance | Inspect and edit without abandoning the source context |
| Confirm | Dialogs, conflict panels, import preview, export limits, toasts | Make consequential outcomes explicit |
| Retain | Saved Views and query state encoded in route/query state, never credentials | Return to work with context intact |

### Inclusive personas

| Persona | Context | Primary tasks | Design pass condition |
|---|---|---|---|
| Keyboard operator | Power user, no pointer during triage | Filter, open peek, edit, comment, move a card, archive | Every action is reachable in logical order; shortcuts never fire in guarded inputs/editors; board move has a named keyboard alternative |
| Screen-reader coordinator | Uses landmarks, headings, tables, and live regions | Compare work, inspect metadata, save a view, handle a conflict | Location, selection, sort, filter, expanded state, errors, and mutation outcomes are announced without relying on position or color |
| Low-vision manager | 200% zoom, high contrast, larger text | Review Projects and deadlines, export a scoped result | Primary content reflows without clipping; focus and selection remain distinct; status never depends on hue alone |
| CJK team member | Chinese, Japanese, or Korean names and long titles | Search, scan lists, comment, import records | CJK glyph coverage is deliberate; line height prevents clipping; IDs/dates remain stable; labels truncate only where full text is available on focus/hover |
| Interruption-heavy contributor | Narrow viewport, reduced motion, variable attention | Open assigned work, change state, comment | One dominant action per surface, plain language, retained draft text, no time-dependent animation, and no hidden critical state |

### Scope guardrail

R4 includes only the screens and primitives specified in this document. Do not add timeline, Cycle, Milestone, Module, documents/pages, rich text collaboration, Runs, agent panels, planning, proposal/review, notifications/inbox, analytics, or other R5+ placeholders to navigation, command palette, empty states, or mock data.

## 2. Color

The shipping R4 theme is light. A future dark theme must define a complete semantic mapping before implementation; components must not improvise dark values.

### Neutral and accent palette

| Role | Token | Value | Usage |
|---|---|---:|---|
| Canvas | `--color-canvas` | `#F7F6F3` | App background and sidebar |
| Surface primary | `--color-surface-1` | `#FFFFFF` | Main work plane, inputs, cards |
| Surface secondary | `--color-surface-2` | `#F1F0EC` | Selected-neutral areas, recessed groups |
| Surface hover | `--color-surface-hover` | `#ECEBE6` | Hovered neutral controls and rows |
| Surface selected | `--color-surface-selected` | `#E7ECF5` | Selected row/card/navigation item |
| Surface disabled | `--color-surface-disabled` | `#EAE9E5` | Disabled fields and actions |
| Ink primary | `--color-ink-1` | `#202327` | Headings and body |
| Ink secondary | `--color-ink-2` | `#555B63` | Supporting text and metadata |
| Ink tertiary | `--color-ink-3` | `#707780` | Placeholders and noncritical hints |
| Ink disabled | `--color-ink-disabled` | `#8C9299` | Disabled labels only |
| Border subtle | `--color-border-subtle` | `#E3E1DC` | Row separators and quiet grouping |
| Border default | `--color-border-default` | `#D1CFC8` | Inputs, controls, cards |
| Border strong | `--color-border-strong` | `#9DA2A8` | Emphasized separators and active resize affordances |
| Accent 50 | `--color-accent-50` | `#EEF3FB` | Selected/hover tint |
| Accent 100 | `--color-accent-100` | `#DDE8F7` | Active tint and focus offset |
| Accent 500 | `--color-accent-500` | `#3C67A5` | Links, selected controls, focus ring |
| Accent 600 | `--color-accent-600` | `#31578E` | Primary actions |
| Accent 700 | `--color-accent-700` | `#284875` | Primary action hover/pressed |
| Overlay | `--color-overlay` | `rgb(32 35 39 / 48%)` | Dialog backdrop |

### Semantic palette

| Meaning | Subtle token | Strong token | Ink token | Non-color cue |
|---|---|---|---|---|
| Success/completed | `--color-success-bg: #E8F3EC` | `--color-success: #2F6F46` | `--color-success-ink: #245738` | Check icon + text |
| Warning/at risk | `--color-warning-bg: #F8EFD9` | `--color-warning: #946819` | `--color-warning-ink: #6F4E13` | Triangle icon + text |
| Error/conflict | `--color-danger-bg: #F8E8E7` | `--color-danger: #A43E38` | `--color-danger-ink: #7E302C` | Alert icon + text |
| Info/in progress | `--color-info-bg: #E8EFF8` | `--color-info: #3C67A5` | `--color-info-ink: #31578E` | Circle-progress icon + text |
| Neutral/inactive | `--color-neutral-bg: #ECEBE7` | `--color-neutral: #626970` | `--color-neutral-ink: #474D53` | Hollow-circle icon + text |

Workflow state and label colors are structured server data. Render each user-defined color only as a small leading swatch/dot beside the state or label name; never flood an entire row/card and never use it as the only cue. If the DTO color is invalid at the display boundary, treat that as a typed rendering error rather than inventing a fallback semantic meaning.

### Focus, selection, and drag tokens

| Token | Value | Purpose |
|---|---|---|
| `--focus-ring` | `0 0 0 2px var(--color-canvas), 0 0 0 4px var(--color-accent-500)` | Universal `:focus-visible` ring |
| `--selection-inset` | `inset 3px 0 0 var(--color-accent-600)` | Selected list row/navigation item |
| `--drop-ring` | `inset 0 0 0 2px var(--color-accent-500)` | Valid board target |
| `--invalid-drop-ring` | `inset 0 0 0 2px var(--color-danger)` | Invalid board target plus text explanation |

### Color rules

- All implementation colors reference semantic tokens from this section. Raw color literals live only in the token definition file generated from this table.
- Accent is reserved for focus, links, active controls, selections, and primary actions. It is not decoration.
- Body text targets at least 4.5:1 contrast; large text and meaningful graphical controls target at least 3:1; focus indicators target 3:1 against adjacent colors.
- Hover, focus, selection, status, conflict, and permission states each combine color with text, icon, border, or position.
- Archived items remain readable. Use an `Archived` badge and reduced emphasis on secondary metadata, not low opacity on the whole item.

## 3. Typography

### Font stack

- **UI and reading:** `"IBM Plex Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", system-ui, sans-serif`.
- **Identifiers, dates, revisions, shortcuts:** `"IBM Plex Mono", "Noto Sans Mono CJK SC", ui-monospace, monospace`.
- Use locally served, subset WOFF2 files where licensing permits. `font-display: swap`; no external font request is required to authenticate or render core UI.
- Enable tabular numbers for counts, dates, revisions, and table metrics. Do not apply monospace to titles, comments, or long descriptions.

### Scale

| Role | Token | Size / line height | Weight | Tracking | Usage |
|---|---|---|---:|---:|---|
| H1 | `--type-h1` | `28px / 36px` | 600 | `-0.018em` | Page title, login title |
| H2 | `--type-h2` | `22px / 30px` | 600 | `-0.012em` | Drawer title, primary section |
| H3 | `--type-h3` | `18px / 26px` | 600 | `-0.008em` | Project card and panel title |
| H4 | `--type-h4` | `16px / 24px` | 600 | `0` | Field-group and dialog title |
| Body | `--type-body` | `14px / 22px` | 400 | `0` | Default UI and reading text |
| Body emphasis | `--type-body-strong` | `14px / 22px` | 550 | `0` | Navigation, row title, labels |
| Compact | `--type-compact` | `13px / 18px` | 400 | `0` | Dense tables and board metadata |
| Compact emphasis | `--type-compact-strong` | `13px / 18px` | 550 | `0` | Table headers and controls |
| Caption | `--type-caption` | `12px / 16px` | 450 | `0.01em` | Short metadata, timestamps, help; never paragraph copy |
| Mono | `--type-mono` | `12px / 16px` | 450 | `0` | Entity keys, revision, date fragments, shortcuts |

### Typography rules

- The default body is never below 14 px. Compact and caption roles are limited to short, adjacent metadata with sufficient contrast.
- Use sentence case everywhere, including buttons and badges. Preserve user-entered title and comment casing.
- Work keys (`ENG-204`), immutable Space keys, dates, revisions, and cursor-related restart messages use mono tokens and tabular numerals.
- Long titles wrap to two lines in cards and project tiles, then truncate with the full value exposed through the accessible name and on focus/hover. Titles wrap without limit in peek/detail.
- CJK text uses at least the declared line height and is never vertically centered in a fixed box that clips glyph ascenders/descenders.
- Plain Markdown-compatible comments render safe text semantics only. Do not use rich-document controls or imply R5 document support.

## 4. Spacing & Layout

### Base scales

All spacing intent uses a 4 px base. Browser mechanics such as `auto`, intrinsic sizing, percentages, `minmax()`, `clamp()`, viewport units, and container units remain raw.

| Token | Value | Typical use |
|---|---:|---|
| `--space-0` | `0` | Reset |
| `--space-1` | `4px` | Icon/text micro-gap |
| `--space-2` | `8px` | Inline cluster, compact control gap |
| `--space-3` | `12px` | Field padding, dense card gap |
| `--space-4` | `16px` | Standard panel padding |
| `--space-5` | `20px` | Comfortable card padding |
| `--space-6` | `24px` | Page gutter on tablet/desktop |
| `--space-8` | `32px` | Major panel grouping |
| `--space-10` | `40px` | Empty-state separation |
| `--space-12` | `48px` | Login and mobile section separation |

| Token group | Values | Rule |
|---|---|---|
| Radius | `--radius-1: 4px`, `--radius-2: 6px`, `--radius-3: 8px`, `--radius-round: 999px` | 4 px for chips/compact cells; 6 px for controls; 8 px for cards/panels/dialogs; round only for avatars, status dots, and compact tags |
| Control height | `--control-sm: 28px`, `--control-md: 36px`, `--control-lg: 44px` | 28 px only in pointer-dense desktop toolbars with a 44 px composed hit target; default 36 px; touch/mobile 44 px |
| Row height | `--row-compact: 36px`, `--row-default: 44px`, `--row-comfortable: 52px` | User density setting changes rows only, not font size or hit target |
| Label lane | `--label-lane: 96px` | Fixed visual lane reserved for up to three labels on a Work row/card; overflow becomes `+N` with full accessible list |
| Icon | `--icon-sm: 14px`, `--icon-md: 16px`, `--icon-lg: 20px` | Standardize icon weight and optical size |

| Layout token | Value | Usage |
|---|---:|---|
| `--sidebar-width` | `240px` | Expanded desktop navigation |
| `--nav-rail-width` | `56px` | Collapsed tablet navigation |
| `--peek-width` | `440px` | Desktop detail peek |
| `--board-column-width` | `288px` | Standard board column track |
| `--login-panel-max` | `400px` | Login form reading width |
| `--reading-measure` | `72ch` | Description/comment maximum measure |

Named responsive thresholds are `mobile: 375px QA minimum`, `tablet: 768px`, and `desktop: 1280px`. Media queries use these documented thresholds directly because CSS custom properties cannot define media-query conditions.

### App shell and scroll ownership

- Root shell uses `min-block-size: 100dvh`, three rows (`top bar / content / optional status region`), and `min-block-size: 0` on every nested flex/grid child that owns scrolling.
- At **1280 px and wider**, the shell has a `--sidebar-width` sidebar, a flexible main work surface, and an optional `--peek-width` drawer over or beside the work surface depending on available container width. The main content, sidebar list, board columns, and peek body own independent scrolling; the browser body does not become the board scroller.
- At **768-1279 px**, the sidebar collapses to `--nav-rail-width`; its expanded state is a focus-trapped overlay. Peek uses an overlaid drawer sized with `min(var(--peek-width), 55vw)` and leaves an obvious context edge behind it.
- At **375-767 px**, navigation is a modal sheet opened from the top bar. Main content is one readable column. Peek becomes a full-screen dialog with a visible Back action that restores the source query, scroll, and selection. Toolbars wrap into a primary row plus an overflow menu; touch targets are at least 44 by 44 px.
- Primary content must not scroll horizontally at 375 px. A table may use a deliberate internal horizontal scroller with sticky key/title column, visible affordance, and non-table card alternative only when the same server result is represented without changing semantics.
- Maximum reading measure is `--reading-measure` for descriptions/comments. Operational tables and boards may fill the available work plane.

### Named spatial primitives

| Primitive | Contract |
|---|---|
| `Shell` | Top bar + navigation + main route outlet; owns viewport sizing |
| `Sidebar` | Workspace switcher, primary nav, Spaces, Saved Views; scrolls independently below fixed identity/actions |
| `PageFrame` | Breadcrumb/title row + local tabs + toolbar + work surface; `min-inline-size: 0` |
| `Toolbar` | Cluster with one primary action at end; wraps by priority rather than shrinking labels |
| `SplitView` | Master/result surface + peek; source retains state and selected item |
| `BoardGrid` | `grid-auto-flow: column`; each column uses `--board-column-width` and independent vertical scroll within one horizontal board scroller |
| `FormStack` | Single-column labels and controls; related short fields may form a two-column grid above 768 px |
| `MetadataGrid` | Labels in a stable first column, values in a flexible second; collapses to stacked labels at 375 px |

### Responsive content priority

- Always visible: entity key/title, workflow state, primary action, query identity, conflict/error, and active filters count.
- Desktop visible: owner, priority, Project, due date, up to three labels, update time.
- Narrow/tablet overflow: type, start date, parent, relation summary, created/completed/archive timestamps.
- Hidden columns are user presentation preferences only. The UI never changes the server query or count merely because a column is hidden.

### Content stress matrix

Implementation must exercise empty data; 100 rows; 25 cards per column; 20 workflow states; 50 labels on a Work Item; 2-line and 200-character titles; unbroken IDs; NULL optional fields; CJK names/titles/comments; archived entities; expired snapshots; revoked authority; and 200% zoom. Use real DTO-shaped fixtures or a live server, never authorization/filter simulations.

## 5. Components and R4 Screen Anatomy

### Shared component state contract

Every interactive primitive implements applicable states: default, hover, active/pressed, `focus-visible`, disabled, loading, success, error, and permission-unavailable. Data surfaces additionally implement loading, populated, empty, stale/expired, selected, archived, and partial-page states. Loading preserves component geometry; empty states state why the result is empty and offer only an in-scope next action. Permission-denied by ID uses the same absence surface as not-found.

### Buttons and icon actions

- **Structure:** native `button` with optional leading icon, text label, and loading indicator. Icon-only buttons require an accessible name and tooltip; frequent or consequential actions stay text-labeled.
- **Variants:** `primary`, `secondary`, `quiet`, `danger`, `icon`; sizes `sm`, `md`, `lg` from Section 4.
- **Spacing:** `--space-2` inline gap; `--space-3` standard horizontal padding; `--space-4` for large.
- **States:** primary uses accent 600/700; secondary uses surface 1 + border default; quiet uses transparent/surface hover; danger uses danger tokens. Loading retains width and exposes busy state. Disabled is not used to conceal a permission error or conflict.
- **Accessibility:** native semantics, visible focus, `aria-disabled` only when the element must remain discoverable with a reason; otherwise `disabled`. Destructive actions name the affected entity.
- **Motion:** micro token for color/opacity and press transform only.
- **Layout:** inline cluster; no button group may contain two equally styled primary actions.

### Input, textarea, select, combobox, and token field

- **Structure:** visible label, required/optional indicator, control, help/error line. Error text remains present until resolved and is associated by `aria-describedby`.
- **Variants:** text, search, password/token, date, textarea, native select where viable, popover combobox for server options, multi-value label/participant token field.
- **States:** empty, filled, focus, invalid, read-only, disabled, loading options, no options, server error. NULL is represented as `Not set`, never fabricated.
- **Accessibility:** label is never placeholder-only; combobox follows ARIA pattern with announced result count; Escape closes without erasing committed values. CJK IME composition must not submit forms or trigger shortcuts.
- **Security:** bearer-token control uses `type=password`, supports paste, never provides reveal-by-default, never echoes token in validation, and clears immediately after successful authentication or any auth reset.
- **Motion/layout:** micro focus transition; `FormStack` owns layout.

### Login form

- **Structure:** centered `--login-panel-max` panel containing product name, H1 `Sign in`, Workspace ID, bearer token, primary `Sign in`, and a short security note: “Your token is kept in memory for this session.”
- **States:** untouched, validating, invalid credentials, unavailable server, signed out after 401, and submitting. Error language never includes credential fragments.
- **Contract:** token exists only in React memory. It is never written to `localStorage`, `sessionStorage`, IndexedDB, cookies by app code, URLs, logs, analytics, error text, or bundled demo data. Refresh, logout, and 401 clear token and query caches.
- **Accessibility:** focus moves to the error summary after failed submit, then links to the invalid field. Password managers are not treated as application persistence.

### App navigation, tabs, and view toggle

- **Structure:** Workspace identity; primary links `Projects`, `Work`, `Search`; scoped Space list; Saved Views list; import/export under a named `Workspace data` action, not as top-level clutter. Local tabs are reserved for views of the same entity.
- **States:** current route uses `aria-current=page`; active tab uses `aria-selected`; expanded groups persist only in non-sensitive route/UI state.
- **View toggle:** named segmented control with `List` and `Board`; updates the route/query representation without resetting filters, sort, snapshot restart context, or Space/Project scope.
- **Scope:** do not render R5+ disabled links or “coming soon” placeholders.

### Query toolbar, filter builder, and sort control

- **Structure:** view toggle, scoped search input, active-filter chips, `Add filter`, sort summary, density/columns menu, result count, and one primary create action. Secondary actions move to overflow before labels disappear.
- **Filter model:** edit a local draft of the strict server filter AST; `Apply` sends it, and only the server response changes membership/counts. Show AST groups as plain-language nested rows up to the server limits (depth 5, 50 nodes), with explicit `All/Any` operators and field/operator/value controls.
- **Sort:** 1-3 ordered entries; server-owned final ID tie-breaker is not editable but may be explained. Drag reorder has Up/Down buttons.
- **States:** no filters, draft differs, applying, applied, invalid server query, expired/revoked snapshot requiring `Restart query`. Do not silently refetch into a different result set while presenting it as the same snapshot.
- **Accessibility:** removable chips include the complete criterion in their accessible name; result changes are announced politely after server response.

### Data table and Work row

- **Structure:** semantic table when columns compare records; caption names the query; sortable headers are buttons with `aria-sort`; rows contain key/title, state, owner, priority, Project, due date, fixed label lane, and configured metadata.
- **Row anatomy:** one of `--row-compact`, `--row-default`, or `--row-comfortable`; `--selection-inset`; archived badge; two-line title ceiling; entity key in mono. Long labels occupy `--label-lane`; show up to three ordered labels then `+N`.
- **Interactions:** Enter opens peek; Space selects only when selection mode exists; context menu key opens named actions; arrow keys do not impersonate an application grid unless full grid semantics are implemented.
- **Pagination:** server snapshot pages append or replace through a visible `Load more`/pagination control. Show loaded and total/bounded context exactly as DTOs provide. No client-side resorting or deduplication.
- **States:** skeleton rows, empty query, no permission-visible data, selected, archived, stale snapshot, load-more error, and 100,000-result bound warning.

### Board, column, and Work card

- **Board:** horizontal `BoardGrid` with one column per returned workflow group, including zero-count columns. Each header shows state name, category cue, server count, and add action when authorized.
- **Card anatomy:** key + priority; title (two lines); owner/Project/date metadata; fixed label lane; archived state. A whole card is not a button: title opens peek, while explicit controls handle actions.
- **Move:** pointer drag is progressive enhancement. On keyboard or touch, `Move…` opens a dialog/listbox of server-permitted destination states, confirms the selection, and submits the revision-safe command. During drag, announce source/target and expose valid/invalid target text. Never reorder optimistically across a server-defined workflow position without a command result.
- **Pagination:** each column has its own cursor and `Load more`; loading one column does not reset others. Board counts remain server counts.
- **States:** empty column remains a target; moving card uses origin placeholder; command success settles returned DTO; failure/conflict restores only that card and preserves open text in peek.

### Peek drawer and Work detail composition

- **Structure:** dialog-like complementary surface with key, title, revision/status line, Close, overflow actions, and tabs/sections for `Details`, `Relations`, and `Comments`. Desktop width is `--peek-width` unless expanded; mobile is full-screen. URL identifies the selected entity while preserving source query state.
- **Details:** description; type; workflow state/category; priority; accountable active human owner; Project; labels; start/due/completion dates; parent; lifecycle timestamps. Explicit NULL displays `Not set`. Fields edit inline only when the complete field state and command are visible.
- **Relations:** grouped typed relation rows with endpoint key/title and archive state. Add relation requires searchable authorized endpoint and type; parent assignment communicates cycle rejection. Missing/denied endpoint is not distinguished.
- **Comments:** thread list and composer primitive below. History may be a permitted link/action only if backed by the R4 history DTO; do not synthesize revision diffs.
- **Focus:** opening moves focus to drawer heading; focus is trapped only when the drawer overlays content. Closing restores focus to originating row/card and its scroll position.
- **States:** loading, not found/denied, populated, archived, editing, saving, conflict, and command error. Background remains inert for modal/mobile presentation.

### Metadata field and editable field row

- **Structure:** stable label/value grid with optional edit action. Dates show localized readable value and machine-stable tooltip/accessible detail; IDs and revision remain exact.
- **States:** view, edit, validating, saving, saved, conflict, and permission-read-only. A saved flash is text/icon based and does not alter layout.
- **Contract:** optimistic mutation is isolated to the edited field. Returned DTO replaces local optimistic state. Other fields never roll back because one field conflicts.

### Comment thread and composer

- **Thread:** author, timestamp, edited indicator if supplied, Markdown-compatible plain content, and authorized edit action. Preserve whitespace and links safely; no rich document blocks.
- **Composer:** textarea, lightweight Markdown help, Cancel, and `Comment`. Draft remains local while the peek is open and survives revision conflict/reload of subject data; it is discarded only by explicit cancel, successful submit, logout, or auth reset.
- **States:** empty, drafting, submitting, failed with retained text, posted, edit conflict, and permission unavailable. Announce new comments without moving focus.

### Project card and Project form

- **Card:** name/title, slug, lifecycle, health, priority, owner, leads, participating Spaces, dates, and revision-aware action menu. Use a structured card grid, not marketing tiles.
- **Form:** name, slug, owner, leads, participating Spaces, lifecycle, health, priority, start/due dates. Slug uniqueness and date constraints are server errors, not client assumptions. Participation copy explicitly states that Project membership does not grant private Space access.
- **List anatomy:** page header, lifecycle/health filters, sort, cards or compact rows, archive visibility control, and create action.

### Space, workflow, state, and label administration

- **Structure:** Space list/detail; immutable uppercase Space key shown in mono; access summary; active workflow; ordered state table; label table. Use page tabs `General`, `Workflow`, `Labels`, `Access` only when their R4 DTO/permissions exist.
- **Workflow state row:** drag handle plus keyboard Up/Down, immutable category, editable name/color/order/default, archive action. Show active count against the maximum of 20.
- **Label row:** swatch, name, usage information only if returned by server, edit/archive action. Work Items may display up to 50 labels but the default UI remains summarized.
- **Permission state:** users lacking `space.manage` see read-only configuration, not inert editable controls. Private Space details are absent when unauthorized.

### Saved View card, save dialog, and view editor

- **Card:** name, owner/scope if returned, model, concise query summary, sort summary, and updated time. Open applies the server-owned query definition unchanged.
- **Save dialog:** prefilled name, clear query summary, `Cancel`, and one primary action: `Save view` for create or `Save changes` for update. `Save as new` is a separate quiet action only in edit context, never adjacent with equal emphasis.
- **Editor:** reuses Query toolbar/filter builder and exposes the strict server schema. Unsupported client fields are not retained or approximated.
- **States:** loading, empty, invalid saved definition from server, conflict, inaccessible scope, and success.

### Global search and command palette

- **Search screen:** search field, kind filter (`Projects`, `Work items`, `Comments`), result groups, match context supplied by DTO, result count/bounds, and pagination. Search starts after explicit submit or a short debounced request only when IME composition is complete. Results never merge client caches or count hidden entities.
- **Command palette:** navigation and already-authorized R4 actions only: go to Projects/Work/Search/Space/Saved View, open recent visible entities, create Project/Work when permission is known, switch list/board, and focus filters. It is not a second search implementation; entity results call the search endpoint.
- **Accessibility:** dialog with combobox/listbox pattern, focus trap, Escape close, arrow navigation, Enter execute, and result count. Shortcut is `Mod+K`; `/` may focus search only outside guarded inputs/editors.

### Dialog, permission/absence state, and revision conflict panel

- **Dialog:** H2/H3 title, concise consequence, body, secondary Cancel, and one named primary action. Initial focus chooses the safest useful control; destructive dialogs focus Cancel. Escape closes unless a commit is in progress.
- **Absence:** shared `Entity unavailable` surface for by-ID not-found or denied. No copy, status icon, retry behavior, or telemetry reveals which case occurred.
- **Collection denial:** generic permission panel with request correlation ID only when returned safely. Do not show forbidden entity names or counts.
- **Conflict panel:** danger-subtle surface inside the active form/drawer with `This item changed on the server`, current server revision, affected fields if returned, retained unsent text, and actions `Reload latest` and `Cancel`. Offer `Reapply` only when a supported command can submit against the new base revision; never silent overwrite.

### Toast and inline status

- **Toast:** transient confirmation for completed actions and nonblocking notices; bottom/end desktop, bottom mobile, max three. Errors requiring repair remain inline at their source and may also announce through the live region.
- **States:** info, success, warning, error. Include entity name/key and undo only when a real inverse command exists; archive/restore are explicit commands, not fake local undo.
- **Accessibility:** `status` for polite updates, `alert` only for urgent failures. Pause dismissal on hover/focus; no essential message auto-dismisses.

### Import preview and commit

- **Structure:** upload/select NDJSON v1 file, file facts, validation progress, manifest summary, per-kind counts, validation errors/warnings with record references, and commit confirmation. Maximum 10 MiB/10,000 records is stated before selection.
- **Contract:** validation token and exact validated bytes are held only as required for the immediate commit flow; the UI never edits validated content between validation and commit. Commit calls the server with the signed token. Credentials, grants, memberships, and tokens are explicitly listed as non-transferable.
- **States:** idle, selected, validating, invalid, valid, token expired/revalidate, committing, replayed identical import, changed-content conflict, success, and failure. Commit is unavailable until server validation succeeds.

### Export control

- **Structure:** current Workspace/query scope summary, included R4 record kinds, `include archived` state from the server query, format `NDJSON v1`, server limits (100,000 records/100 MiB), and `Export` action.
- **Contract:** export sends the current normalized server query/scope; it never exports client cache contents. Authorization and endpoint filtering are server-owned. Download naming includes Workspace-safe slug and UTC date, never credentials/query text.
- **States:** ready, preparing, streaming/downloading, limit rejected before stream, authorization changed, and failure. Show progress only when truthful server/browser progress exists; otherwise use indeterminate status.

### R4 screen anatomy

| Route/screen | Header and controls | Primary surface | Secondary/overlay |
|---|---|---|---|
| Login | Product identity | Bearer login form | Auth error summary |
| Projects | Breadcrumb, H1, lifecycle/health filters, sort, Create project | Structured Project cards/rows | Project create/edit dialog |
| Project detail | Project identity, revision, lifecycle/health, Edit | Outcome metadata, participating Spaces, scoped Work query | Work peek |
| Space detail | Space identity/key, visibility, local tabs | General/workflow/states/labels/access tables | Edit dialogs and permission state |
| Work list | Scope, Saved View identity, list/board toggle, query toolbar | Server-paged semantic table | Work peek, filter builder, conflict panel |
| Work board | Same context and query toolbar | Server-grouped board with independent column cursors | Work peek, keyboard Move dialog |
| Work peek | Source remains visible | Details/relations/comments | Field editors, relation dialog, conflict panel |
| Saved Views | H1, model/scope filter, Create view | Saved View cards/rows | Save/edit dialog using query builder |
| Search | H1, search, kind filter | Grouped server results with pagination | Selected result opens route or peek where valid |
| Import | H1 and constraints | File selection, validation preview, exact commit summary | Commit confirmation/conflict |
| Export | H1 and scope | Export configuration and server limit disclosure | Preparing/error status |

## 6. Motion & Interaction

### Timing tokens

| Token | Duration | Easing | Use |
|---|---:|---|---|
| `--motion-instant` | `0ms` | linear | Reduced-motion replacement and immediate state |
| `--motion-micro` | `100ms` | `cubic-bezier(0.2, 0, 0, 1)` | Press, focus color, checkbox, selection |
| `--motion-standard` | `180ms` | `cubic-bezier(0.2, 0, 0, 1)` | Popover/dialog opacity, toast |
| `--motion-panel` | `240ms` | `cubic-bezier(0.16, 1, 0.3, 1)` | Peek transform and backdrop opacity |

### Interaction rules

- Animate only `transform`, `opacity`, and non-layout color/filter transitions. Never animate width, height, top, left, grid tracks, or scroll position.
- Motion communicates state: peek entering, menu opening, card move settling, success/error feedback. There is no ambient, scroll-triggered, staggered, parallax, decorative, or loading-loop motion beyond a restrained progress indicator.
- The context seam is the only signature transition: the selected source row/card receives selection state as the peek translates in from the inline end. Closing reverses it and restores focus. It must remain understandable at `0ms`.
- `prefers-reduced-motion: reduce` sets all motion tokens to `0ms`, removes drag lift/translation animation, and uses immediate visibility changes. No task depends on observing movement.
- Optimistic feedback is allowed only after a revision-safe command begins. The affected component uses `aria-busy`; unrelated surfaces remain interactive. Failure returns the component to the server DTO and announces the reason.

### Keyboard contract

| Key | Context | Result |
|---|---|---|
| `Mod+K` | Outside modal input | Open command palette |
| `/` | Outside input/editor/IME composition | Focus scoped search |
| `Enter` | Focused row/card title | Open peek |
| `Escape` | Palette/popover/dialog/peek | Close the topmost dismissible layer and restore trigger focus |
| `Tab` / `Shift+Tab` | Everywhere | Follow DOM/task order; trap within modal layers only |
| Arrow keys | Tabs/listbox/menu | Follow the component's ARIA pattern |
| `Move…` action | Board card | Open keyboard-accessible destination chooser; pointer drag is never required |

Inputs, textareas, selects, content rendered as editors, open comboboxes, and active IME composition are guarded from global shortcuts. Do not hijack browser Find, Back, Refresh, or standard text-editing keys.

## 7. Depth & Surface

### Strategy: tonal shift with exact borders

Depth comes from warm-neutral surface steps and precise borders. Shadows are reserved for genuinely floating layers, never ordinary cards or rows.

| Level | Token/treatment | Usage |
|---|---|---|
| Canvas | `--color-canvas` | Shell and sidebar background |
| Work plane | `--color-surface-1` + subtle inline border | Main content plane |
| Recessed | `--color-surface-2` | Filter groups, code/file summary, empty wells |
| Selected | `--color-surface-selected` + `--selection-inset` | Active navigation, row/card |
| Floating | `--color-surface-1`; border default; `--shadow-popover: 0 8px 24px rgb(32 35 39 / 12%), 0 1px 3px rgb(32 35 39 / 10%)` | Menus, comboboxes, command palette |
| Dialog | `--color-surface-1`; border default; `--shadow-dialog: 0 20px 48px rgb(32 35 39 / 18%), 0 2px 8px rgb(32 35 39 / 10%)` | Modal dialogs and mobile peek |

### Surface rules

- Cards use `--color-border-default` and `--radius-3` with no resting shadow. Rows generally use bottom borders, not individual boxes.
- Sidebar and main plane meet at one border. Do not put every sidebar section in a card.
- Peek uses a stronger leading border on desktop plus dialog shadow only when overlaid. Side-by-side peek uses no outer shadow.
- Board columns use canvas/recessed backgrounds; cards use surface 1. This two-step contrast keeps metadata calm without flattening the board.
- Sticky headers add a bottom border when content scrolls beneath; no blur or glass treatment.
- Popovers and dialogs must remain visually distinct in Windows high-contrast/forced-colors mode through system borders and outlines.

## 8. Accessibility Constraints & Accepted Debt

### Target and semantic structure

- Target **WCAG 2.2 AA** and applicable cognitive accessibility guidance. Accessibility outranks the visual reference.
- Landmarks: one banner, one primary navigation, one main per route, complementary peek only when nonmodal, and named regions for query controls and results.
- Maintain a logical H1-H4 hierarchy. Route changes update document title and move focus to H1 unless opening/closing a context-preserving peek.
- Use native table, form, button, link, dialog, details, and list semantics before ARIA. ARIA communicates state; it does not repair incorrect DOM roles.
- Every control has a visible label or persistent tooltip plus accessible name. Consequential and frequent actions use visible text.

### Keyboard, focus, and layers

- All R4 tasks are keyboard-complete: login; create/edit/filter; switch list/board; open/close peek; move board card; add relation/comment; save view; search; archive/restore; import; export.
- `:focus-visible` uses `--focus-ring` and is never removed. Selection and focus can coexist visibly.
- Modal dialog, mobile navigation, command palette, and mobile peek trap focus, make background inert, close on Escape when safe, and restore trigger focus. Side-by-side desktop peek does not trap focus.
- Pointer drag always has `Move…` plus ordered destination controls. Reordering workflow states and sort entries also has Up/Down alternatives.

### Screen reader and live feedback

- Announce route/page title, loaded result count, active filters, sort direction/order, selected entity, expanded/collapsed sections, board move source/destination, conflict, and mutation outcome.
- Use one polite live region for result/mutation status and an assertive region only for blocking auth, import, or conflict errors. Do not announce every skeleton or pointer hover.
- Tables have captions and header associations. Board columns are named regions/lists with state and count; cards are list items with separate named actions.
- Decorative swatches and icons are hidden from assistive technology. Status accessible names include both state and category where relevant.

### Vision, text, locale, and cognition

- Contrast floors follow Section 2. At 200% zoom and 320 CSS px effective width, no primary-content horizontal scroll, overlap, or clipped actions.
- Support browser text resizing without replacing text with icons. Fixed heights are limited to controls/rows whose content truncation contract is defined.
- CJK strings use declared fallback fonts and line heights. Test mixed Latin/CJK titles, names, comments, and labels at all target widths.
- Dates show localized presentation while preserving exact machine value in accessible detail. Entity IDs, Space keys, revisions, and imported external IDs are never localized or reformatted.
- Plain language states the problem, affected object, and next action. Avoid timing pressure, auto-advancing content, and color-only instructions.

### Security and privacy constraints

- Bearer credentials are React-memory-only and absent from browser storage, URLs, logs, analytics, error reporting, screenshots/fixtures, source maps, and bundled demo content.
- Logout, refresh, and 401 clear auth and all cached server data. Same-origin production is assumed by the contract.
- UI telemetry must not include IDs, queries, request/response bodies, comments, filenames, search text, or credentials. Correlation ID may be displayed only when the server returns it safely.
- The client never reveals unauthorized candidates through option lists, counts, board columns, search snippets, relation pickers, export summaries, or cached stale content after authority changes.

### Error, empty, and conflict content

- Empty states distinguish `No items yet` from `No results for these filters` only when the server response permits that distinction. They never infer hidden items.
- By-ID denied and missing share one `Entity unavailable` treatment. Collection 403 remains generic.
- Snapshot expiration or authority change says `This result set can no longer continue` with a primary `Restart query` action; it does not silently merge a fresh query.
- Revision conflict retains unsent text, identifies the affected edit, and provides explicit recovery. No overwrite language is ambiguous.

### Accepted debt

No accessibility or design debt is accepted at design time.

| Item | Location | Why accepted | Owner / exit |
|---|---|---|---|
| None | N/A | No known exception is justified before implementation evidence exists | Any discovered debt must be added here with affected users, severity, exact fix, owner, and explicit user acceptance |

### Implementation and evidence handoff

1. Generate implementation tokens from Sections 2-4 and 6-7; visual code may not introduce untracked color, spacing, type, radius, shadow, or duration values.
2. Build a primitive showcase covering every Section 5 primitive and applicable state at 375, 768, and 1280 px before composing product screens.
3. Exercise content stress from Section 4 with live DTOs or DTO-faithful fixtures. The fixtures may shape layout testing but may not simulate authorization, filtering, search, counts, or command success.
4. Verify keyboard-only and screen-reader flows, focus restoration/traps, reduced motion, 200% zoom, forced colors, CJK clipping, and token security.
5. Run real-browser visual QA on every R4 screen and breakpoint only after implementation. Lane C review then evaluates the same evidence for brief fidelity, WCAG/COGA, Nielsen heuristics, and the inclusive personas above.
6. Route significant completed implementation through final review with visual artifacts, accessibility findings, persona walkthroughs, and any explicitly accepted debt. This document is a handoff contract, not evidence that those gates have passed.
