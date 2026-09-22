---
name: Oneida County 911 Activity Map
description: A live public-safety dispatch console — dark slate chrome, one loud heatmap.
colors:
  bg-dark: "#1c2330"
  panel-dark: "#232b3a"
  text-dark: "#e8ecf3"
  muted-dark: "#aab4c5"
  border-dark: "#3a4555"
  bg-light: "#f2f5fa"
  panel-light: "#ffffff"
  text-light: "#1c2330"
  muted-light: "#5b6b82"
  border-light: "#cdd6e4"
  accent: "#2563eb"
  map-fill: "#d7e3ee"
  cat-police: "#4361ee"
  cat-fire: "#e63946"
  cat-ems: "#2a9d8f"
  cat-other: "#9aa0b4"
typography:
  display:
    fontFamily: "system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  control: "4px"
  chip: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-dark}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  chip-off:
    backgroundColor: "transparent"
    textColor: "{colors.muted-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "3px 10px"
  chip-on:
    backgroundColor: "{colors.panel-dark}"
    textColor: "{colors.text-dark}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "3px 10px"
---

# Design System: Oneida County 911 Activity Map

## Overview

**Creative North Star: "The Dispatch Console"**

A control-room instrument, not a brochure. The app chrome is quiet dark slate that
recedes so the heatmap — the only loud thing on screen — carries all attention. Density
is high and purposeful: compact header controls, 12–13px type, wrapping rows that never
clip the map. Nothing decorative; every pixel serves scanning speed on a phone in a
parking lot or a researcher's second monitor.

Light mode exists as an alternate console finish (white panels, same slate ink), but
dark is the default look. Both modes share one rule: the chrome stays flat and tonal,
and color appears only where it means something — the accent blue for actions, four
category hues for data.

**Key Characteristics:**
- Dark-slate-first chrome with a light alternate finish, persisted per browser
- Flat surfaces, no shadows; depth from tonal layering (bg < panel)
- Compact unobtrusive controls (4px radius, ghost borders over solid accents)
- State shown by color/border shift, never motion
- Category colors are the system's only saturated palette — reserved strictly for data

## Colors

A near-monochrome slate scale with one action accent and a four-hue category set.

### Primary
- **Console Accent Blue** (#2563eb): The single actionable color — primary buttons, active-state chip borders. It is the only non-data use of saturation.

### Neutral
- **Slate Base** (#1c2330): App background (dark). Light-mode counterpart #f2f5fa.
- **Panel Slate** (#232b3a): Header/chip-bar surface, sitting one step above base to convey layering without a shadow. Light: #ffffff.
- **Signal Text** (#e8ecf3): Primary text on dark. Light-mode ink reuses #1c2330.
- **Muted Slate** (#aab4c5): Secondary text — labels, status line, credit. Light: #5b6b82.
- **Border Slate** (#3a4555): Dividers between header rows and ghost-button strokes. Light: #cdd6e4.
- **No-Coverage Fill** (#d7e3ee): Pale blue-grey shown when panning beyond the local tile pyramid, replacing a broken white void.

### Data hues (strictly for incidents)
- **Police Indigo** (#4361ee): Police heat layer + chip dot.
- **Fire Red** (#e63946): Fire/HAZMAT heat layer + chip dot.
- **EMS Teal** (#2a9d8f): EMS heat layer + chip dot.
- **Other Grey** (#9aa0b4): Unclassified heat layer + chip dot; deliberately desaturated.

**The Data-Hue Rule.** The four category colors appear only as map heat layers and their
matching chip dots. They never style chrome, buttons, or text. Keep them out of the UI
and they stay legible as data on any basemap.

## Typography

**Display Font:** system-ui (sans-serif stack — no webfont, fully offline)
**Body Font:** system-ui
**Label/Mono Font:** none distinct

**Character:** One family at three sizes. The absence of a display face is deliberate:
this tool borrows zero typographic personality so the map keeps it all.

### Hierarchy
- **Display** (600, 15px): Page title in the header. Small by design — a console label, not a headline.
- **Body** (400, 13px): Controls, date labels, status line.
- **Label** (400, 12px): Chips, credit line, county row.

**The No-Webfont Rule.** Type stays on the system stack. Any new surface keeps this:
the app must render identically with zero network fetches for fonts, tiles, or libraries.

## Layout

Single-column flexbox: wrapping header, then two thin filter bars (county toggles,
category chips), then `#map` filling all remaining height (`flex: 1; min-height: 0`).
Rows wrap on narrow screens and never clip the map. Map resyncs via ResizeObserver plus
resize/orientation events.

Spacing rhythm is tight and uniform: 6/8/10/12/14px gaps and paddings, 14px side gutters
on every bar. Density favors scanning over breathing room.

## Elevation & Depth

Flat. No box-shadows anywhere. Depth comes from tonal layering — panel slate (#232b3a)
sits one step lighter than base slate (#1c2330), and rows are separated by a 1px border
(#3a4555). The map itself reads as the deepest layer because it's the only thing that moves.

**The Flat-By-Default Rule.** Surfaces stay flat at rest. Never add a shadow to convey
hierarchy; use a tone step or a 1px divider instead.

## Shapes

Two radii do everything: a sharp 4px for controls (buttons, date inputs) and a full pill
(999px) for filter chips. Category dots are true circles (50%). No other corner language
exists in the system.

## Components

### Buttons
- **Shape:** 4px radius
- **Primary:** accent blue fill (#2563eb), white text, 13px, `5px 12px` padding — used once ("Update map")
- **Ghost:** transparent, muted text, 1px border-slate stroke; `.active` swaps to signal text + accent border
- **Focus:** 2px outline in signal color, 2px offset

### Chips (filter pills)
- **Style:** pill shape, dashed 1px border when off (muted text), solid border + panel background + full text when on
- **State:** exclusive-select model — clicking a category isolates it as the sole visible one; `aria-pressed` mirrors that isolation, and the isolated chip's label flips to "Only <Category> (<n>)" so the state reads in text, not just color. The All chip resets. A trailing hint ("Click isolates · All resets") teaches the model at first glance.
- Each category chip carries an 8px colored dot matching its heat layer; counts shown inline
- **County toggles** reuse the same chip anatomy without dots

### Inputs / Fields
- **Date fields:** panel background, 1px border-slate, 4px radius, `4px 6px` padding, 13px label prefix in muted slate

### Status line
- 13px muted slate, `role="status" aria-live="polite"`; doubles as freshness indicator (`· updated <time>`) and plain-language error with a recovery path

## Do's and Don'ts

### Do:
- **Do** keep chrome tonal: only #2563eb for actions and the four data hues for incidents.
- **Do** express state through color/border shifts (ghost active = accent border + full text).
- **Do** size new controls to the existing compact scale (12–13px type, 4px radius, ≤10px padding).
- **Do** add new filter options as pills in the chip bar, not as new header buttons.

### Don't:
- **Don't** introduce shadows — depth is tonal steps and 1px dividers only.
- **Don't** style chrome or text with category colors; they are reserved for map data and chip dots.
- **Don't** load webfonts, external tile APIs, or third-party libraries — the app ships fully self-contained.
- **Don't** use motion/transitions for state changes; the incumbent system signals state statically.
