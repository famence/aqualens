---
"@aqualens/core": patch
---

Re-read the lens `tint` from CSS whenever the element's class or style changes (or during a transition/animation). Previously the tint was sampled only once at construction, so toggling a class that changed `background-color` did not update the lens tint.
