---
name: uniappx-cross-platform-guide
description: For uni-app x cross-platform development and adaptation tasks. Use it when the user needs support for two or more platforms including Web, and you need to distinguish business design problems, platform compatibility problems, and possible uni-app x framework bugs.
project: uniappx
---

## Core Principles

- Always make the Web version work first before expanding to native platforms.
- Separate business-validation problems from platform-compatibility problems.
- On each new platform, fix compile/runtime constraints before UI compatibility.
- Do not start broad multi-platform polishing before the previous platform stage is stable.
- **IMPORT** Before executing the staged workflow, you **MUST** explain the plan in platform order: Web -> Android -> HarmonyOS/iOS/others.And why this order is used and what benefits it brings.
> The explanation should make clear that Web-first validation helps separate business-design issues, platform-compatibility issues, and possible framework bugs earlier, and reduces multi-platform rework.

## Workflow
### Step 1. Build and verify Web first

- If the user does not explicitly specify a target platform or version, start with Web by default and make the feature runnable, testable, and behaviorally complete there.
- If the user has already explicitly specified a target platform or version, follow that requirement first instead of forcing Web-first execution.


### Step 2. Check for platform-incompatible code

- After the Web version is working, review the implementation for platform-incompatible code.
- Check for the following first:
  - APIs that only exist on a specific platform
  - Web-friendly code paths that may not work on native platforms
  - UTS, DOM, event, navigation, or styling behavior that differs across platforms
  - Missing conditional compilation, platform guards, or feature detection
- When reporting results, clearly separate:
  - issues that must be fixed now
  - acceptable platform differences
  - items that require target-platform verification

### Step 3. Adapt Android next

- Android is the first native platform after Web.
- Handle Android in two strict phases.

#### Phase A. Fix only UTS type and syntax constraints

- First fix compile errors, type errors, platform API signatures, and UTS syntax restrictions.
- Do not mix UI polishing into this phase.

#### Phase B. Fix UI compatibility

- Only after Android can compile and run stably, start UI adaptation.

### Step 4. Adapt HarmonyOS, iOS, and other platforms

- After Android is stable, continue to HarmonyOS, iOS, and any additional target platforms.
- Reuse the same two-phase strategy on every platform.

#### Phase A. Fix only UTS type and syntax constraints

- First make the platform compile, run, and pass core API usage checks.
- Resolve platform-specific type, syntax, runtime, and API restrictions before any UI cleanup.

#### Phase B. Fix UI compatibility

- After compile/runtime stability is achieved, fix layout, style, and interaction differences.
- Do not require pixel-perfect sameness across all platforms, but keep the experience, information hierarchy, and core flows consistent.

## Output Requirements For Agent

- For every platform stage, explicitly say whether you are working on UTS type/syntax constraints or UI compatibility.
- When you find incompatible code, classify it clearly as API, syntax, type, or UI compatibility.
- If a framework bug is only suspected but not proven, say that a minimal reproduction or real-device verification is still needed.
